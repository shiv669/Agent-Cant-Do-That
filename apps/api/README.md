# API App

NestJS backend for authority lifecycle enforcement, ledger persistence, and Token Vault powered billing export.

## Run

From repository root:

```bash
npm install
npm run dev:api
```

Health check:
- `http://localhost:4001/api/health`

## Main responsibilities

- Start and track offboarding workflows
- Enforce per-action authority windows (request, claim, consume, revoke)
- Append-only authority ledger in PostgreSQL
- SSE ledger streaming for live console feed
- Token Vault exchange and Google Sheets evidence export

## Key endpoints

- `POST /api/workflows/offboarding/start`
- `GET /api/workflows/:workflowId/status`
- `GET /api/authority/ledger/:workflowId`
- `GET /api/authority/ledger/:workflowId/stream` (SSE)
- `POST /api/authority/window/request`
- `POST /api/authority/window/claim`
- `POST /api/authority/window/consume`
- `POST /api/authority/high-risk/check`

## Environment

Configured from repo root `.env`.

Required groups:
- Runtime and infra: `PORT`, `DATABASE_URL`, `REDIS_URL`, `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`
- Auth0: `AUTH0_DOMAIN`, `AUTH0_AUDIENCE`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`
- CIBA and authority: `AUTH0_CIBA_CLIENT_ID`, `AUTH0_CIBA_CLIENT_SECRET`, `AUTH0_CIBA_AUDIENCE`, `CFO_USER_ID`, `DPO_USER_ID`
- Token Vault exchange: `AUTH0_TOKEN_VAULT_CLIENT_ID`, `AUTH0_TOKEN_VAULT_CLIENT_SECRET`, `AUTH0_CONNECTION_NAME`
- Agent runtime model: `AGENT_MODEL_PROVIDER`, `AGENT_MODEL_NAME`, `GROQ_API_KEY`

Additional vars used by API fallback and demo flows:
- `AUTH0_CUSTOM_API_CLIENT_ID`, `AUTH0_CUSTOM_API_CLIENT_SECRET`
- `OPS_USER_ID`, `OPS_MANAGER_EMAIL`, `OPS_MANAGER_PASSWORD`, `AUTH0_PASSWORD_REALM`
- `DEMO_MODE_ENABLED`, `DEMO_ADMIN_KEY`
- `TOKEN_VAULT_BILLING_EXPORT_REQUIRED`
