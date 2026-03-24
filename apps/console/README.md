# Console App

Next.js operations console for live offboarding execution, authority intervention, and evidence visibility.

## Structure

- `app/` App Router routes and pages
- `app/page.tsx` main operations console
- `app/ledger/[workflowId]/page.tsx` ledger-focused view
- `lib/auth0.ts` Auth0 server client configuration
- `lib/` shared UI utilities

## Run

From repository root:

```bash
npm install
npm run dev:console
```

Open:
- `http://localhost:3000/`

## Environment

The console reads env from repo root `.env` (or app-local env files).

Required:
- `NEXT_PUBLIC_API_URL`
- `AUTH0_DOMAIN`
- `AUTH0_CLIENT_ID`
- `AUTH0_CLIENT_SECRET`
- `AUTH0_SECRET`
- `APP_BASE_URL`
- `AUTH0_AUDIENCE`

Optional:
- `AUTH0_MY_ACCOUNT_AUDIENCE` (defaults to `https://<AUTH0_DOMAIN>/me/`)

## Runtime behavior

- Workflow status polling uses `GET /api/workflows/:workflowId/status`
- Ledger events stream live through SSE from `GET /api/authority/ledger/:workflowId/stream`
- Authority requests and consumes send reasoning metadata for auditability
