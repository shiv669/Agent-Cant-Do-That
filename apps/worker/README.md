# Worker App

Temporal worker that executes workflow activities and writes lifecycle events through the API/ledger path.

## Run

1. Start infrastructure from repository root:

```bash
npm run infra:up
```

2. Start worker from repository root:

```bash
npm install
npm run dev:worker
```

## Environment

Read from root `.env`:

- `TEMPORAL_ADDRESS` (default `localhost:7233`)
- `TEMPORAL_NAMESPACE` (default `default`)
