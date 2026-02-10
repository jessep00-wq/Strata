# Strata

A Next.js application with API routes for healthcare scorecard analysis.

## Structure

```
app/
  api/
    analyze-scorecard/
      route.ts     # API endpoint for PDF and image analysis
  page.tsx         # Main page component
  public/
    scorecard.html # Scorecard UI
```

## Deployment

This project is designed to be deployed on Vercel. The API routes use the default Node.js runtime (no explicit runtime configuration needed).
