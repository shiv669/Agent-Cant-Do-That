# Auth0 Provisioning

This folder contains an idempotent setup script to create/update the required Auth0 resources for Agent Can't Do That.

## What it provisions

- Resource server (API): `https://agent-cant-do-that/api`
- API scopes:
  - `orchestrate:customer_offboarding`
  - `execute:refund`
  - `execute:data_deletion`
- Roles:
  - `operations_manager`
  - `cfo`
  - `dpo`
- Applications:
  - `acdt-console`
  - `acdt-api`
  - `acdt-worker`

## Required environment variables

Set these before running:

- `AUTH0_DOMAIN`
- `AUTH0_BOOTSTRAP_CLIENT_ID`
- `AUTH0_BOOTSTRAP_CLIENT_SECRET`

`AUTH0_BOOTSTRAP_CLIENT_ID/SECRET` must belong to a Machine-to-Machine app that has Management API scopes sufficient for clients, resource servers, and roles (create/read/update).

## Run

From repository root:

```bash
npm run setup:auth0
```

## Notes

- Script is idempotent: it will update existing resources where possible.
- It does not create users; role assignment to users is intentionally left to tenant operators.
