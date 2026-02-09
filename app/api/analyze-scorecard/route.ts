export const runtime = "nodejs";

import pdf from "pdf-parse";

function cleanMeasureName(name: string) {
  return String(name || "")
    .replace(/\s*\([^)]*(CMS|NQF)[^)]*\)\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fileToBase64(file: File) {
  const buf = Buffer.from(await file.arrayBuffer());
  return buf.toString("base64");
}

async function extractPdfText(file: File) {
  const buf = Buffer.from(await file.arrayBuffer());
  const result = await pdf(buf);
  return result.text || "";
}

export async function POST(req: Request) {
  try {
    const form = await req.formData();

    const providerName = String(form.get("providerName") || "").trim();
    const reportingMonth = String(form.get("reportingMonth") || "").trim();
    const reportingYear = String(form.get("reportingYear") || "").trim();
    const files = (form.getAll("files") || []).filter(Boolean) as File[];

    if (!providerName || !reportingMonth || !reportingYear) {
      return Response.json({ error: "Missing required fields" }, { status: 400 });
    }
    if (!files.length) {
      return Response.json({ error: "No files uploaded" }, { status: 400 });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return Response.json({ error: "OPENAI_API_KEY not set in Vercel" }, { status: 500 });
    }

    // 1) Extract PDF text
    let combinedPdfText = "";
    // 2) Prepare images for vision
    const imageInputs: any[] = [];

    for (const f of files) {
      const ct = (f.type || "").toLowerCase();

      if (ct === "application/pdf") {
        const text = await extractPdfText(f);
        if (text && text.trim()) {
          combinedPdfText += `\n\n--- PDF: ${f.name} ---\n${text}`;
        } else {
          combinedPdfText += `\n\n--- PDF: ${f.name} ---\n[No readable text extracted]`;
        }
      }

      if (ct.startsWith("image/")) {
        const b64 = await fileToBase64(f);
        imageInputs.push({
          type: "input_image",
          image_url: `data:${ct};base64,${b64}`,
        });
      }
    }

    const instruction = `
You are a Healthcare Quality Operations Expert and Performance Coach.
Extract provider performance metrics from the supplied scorecard(s).

Rules:
- Return JSON ONLY. No markdown. No commentary.
- Clean measure names: remove (CMS...) and (NQF...) codes.
- Do not invent numbers. If not found, use null (provider fields) or omit the measure entry.
- Measures must include numerator and denominator when present.

Return JSON with this schema:

{
  "provider": {
    "providerName": string,
    "reportingMonth": string,
    "reportingYear": string,
    "currentEncounters": number|null,
    "priorEncounters": number|null,
    "awvsCompleted": number|null,
    "awvsGoal": number|null,
    "tocsCompleted": number|null,
    "tocsGoal": number|null
  },
  "measures": [
    { "name": string, "numerator": number, "denominator": number }
  ],
  "narrative": {
    "why": string,
    "how": string,
    "priorities": [
      { "t": string, "d": string },
      { "t": string, "d": string },
      { "t": string, "d": string }
    ]
  }
}
`;

    const userText =
      `Provider: ${providerName}\nMonth: ${reportingMonth}\nYear: ${reportingYear}\n\n` +
      `PDF Extracted Text (if any):\n${combinedPdfText || "[No PDFs uploaded or no text extracted]"}\n\n` +
      instruction;

    // OpenAI Responses API call
    const oaiRes = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0.2,
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: userText }, ...imageInputs],
          },
        ],
      }),
    });

    if (!oaiRes.ok) {
      const details = await oaiRes.text().catch(() => "");
      return Response.json({ error: "OpenAI error", details }, { status: 500 });
    }

    const data = await oaiRes.json();

    const raw =
      data?.output?.[0]?.content?.find((c: any) => c.type === "output_text")?.text ||
      data?.output_text ||
      "";

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return Response.json({ error: "Model did not return valid JSON", raw }, { status: 500 });
    }

    // Enforce identity fields from the gate
    parsed.provider = {
      ...(parsed.provider || {}),
      providerName,
      reportingMonth,
      reportingYear,
    };

    // Normalize measure names server-side too
    if (Array.isArray(parsed.measures)) {
      parsed.measures = parsed.measures
        .map((m: any) => ({
          name: cleanMeasureName(m?.name),
          numerator: Number(m?.numerator ?? 0),
          denominator: Number(m?.denominator ?? 0),
        }))
        .filter((m: any) => m.name);
    } else {
      parsed.measures = [];
    }

    return Response.json(parsed);
  } catch (err: any) {
    return Response.json(
      { error: "Unhandled server error", details: String(err?.message || err) },
      { status: 500 }
    );
  }
}
