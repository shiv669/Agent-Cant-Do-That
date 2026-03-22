![Agent Can't Do That](./ACDT.png)
 # Agent Can't Do That

Irreversible Authority Windows in Multi-Agent Systems

For evaluation: read this README first, then [PRD.md](PRD.md), then [ADR.md](ADR.md).

## What this project is

An AI agent prepared an `$82,000` refund and a permanent deletion across `14` data stores. It could not execute either. Neither could the person running the system.

This project enforces why that is the correct behavior in multi-agent systems.

Core thesis:

> Authorization is an event lifecycle (create → claim → consume → destroy), not a persistent permission state.

In plain terms:
- An orchestrator agent can coordinate work.
- It cannot execute high-risk irreversible actions by inherited authority.
- Each irreversible action requires a fresh, role-approved, single-use authority window.

If the window is missing, expired, transferred, or replayed, execution is blocked.

---

## For Judges

### The broken assumption we challenge

Most agent systems assume authority flows down agent hierarchies.

This project rejects that assumption at infrastructure level.

Sub-agents do not inherit irreversible execution authority.

### What to look for in the demo

1. Low-risk actions run successfully without drama.
2. First high-risk action is hard-blocked by a real 403.
3. Override/escalation attempt is silently recorded as unauthorized.
4. Step-up approval arrives on a separate physical device.
5. Single-use authority window is consumed and revoked after one execution.
6. Second high-risk action is blocked again, proving no carry-forward authority.
7. Final authority ledger shows all events, including the override attempt.

### Win condition

The system should create this exact reaction:

"This refused me personally. And logged it."

---

## Use Case in Scope

Enterprise SaaS customer offboarding with two irreversible actions:

- Refund requires CFO approval
- Permanent data deletion requires DPO approval

Low-risk steps execute normally:
- Revoke SSO access
- Export billing history
- Cancel subscriptions

---

## System Guarantees

- No authority inheritance for irreversible actions
- No authority carry-forward across irreversible actions
- No transfer of authority artifacts between agents
- Single-use authority window claim and consume model
- Replay always rejected
- Fail-closed behavior under authorization uncertainty
- Immutable, append-only authority ledger

---

## Architecture (MVP)

- Identity and step-up: Auth0 for AI Agents + Token Vault + MFA + RBAC
- Workflow runtime: Temporal (TypeScript)
- Backend API: NestJS (TypeScript)
- Console UI: Next.js (App Router)
- System of record: PostgreSQL (append-only ledger)
- Ephemeral coordination: Redis for WebSocket status fan-out and short-lived read cache only; not used for authority state
- Observability: OpenTelemetry via OTLP-compatible backend

Detailed architectural decisions and alternatives are in [ADR.md](ADR.md).

Detailed product and behavior requirements are in [PRD.md](PRD.md).

---

## Authority Model

### Required scopes in MVP

- orchestrate:customer_offboarding
- execute:refund
- execute:data_deletion

### High-risk execution rule

A sub-agent can execute a high-risk action only if all checks pass:

1. authority window exists
2. scope matches action
3. window TTL valid at claim time
4. window bound to claimant agent identity
5. window not previously consumed

Otherwise: block + log.

---

## Authority Ledger (Required Evidence)

The final screen is the authority ledger, not a success screen.

Minimum evidence fields include:
- orchestrator authorizer identity
- orchestrator scope
- action status (success or blocked)
- escalation attempt status
- escalation event type: unauthorized_escalation_attempt_recorded
- approver identity per high-risk action
- authority window TTL
- authority window binding confirmation (window bound to specific sub-agent identity)
- token and window lifecycle states (minted, consumed, revoked)
- replay status
- cross-action propagation check showing no carry-forward authority

---

## Judge-to-Criteria Mapping

- Security model: real deny path, per-action authority windows, replay resistance
- User control: explicit approver roles and complete ledger visibility
- Technical execution: load-bearing Token Vault integration and deterministic workflow transitions
- Design: intentional enterprise console ending in accountability ledger
- Potential impact: enterprise-ready pattern for irreversible agent actions
- Insight value: authorization as event lifecycle, not possession state

---

## Developer Notes

Primary implementation specs:
- [PRD.md](PRD.md)
- [ADR.md](ADR.md)

### Implementation priorities

1. Build authority-window lifecycle APIs and claim checks
2. Implement Temporal workflow for offboarding path
3. Integrate Auth0 step-up routing by action role
4. Build immutable ledger persistence and query views
5. Add console flow and final ledger screen
6. Add observability traces visible during demo

### Non-functional requirements baseline

- Deny path target latency: under 300ms p95 (excluding human approval wait)
- Authorization checks fail closed
- Workflow state durable across restarts
- Ledger append-only with immutable insertion timestamp and monotonic sequence ID

---

## Setup and Running

### 1. Prerequisites

- Node.js 20+
- npm 10+
- Docker Desktop (for Postgres, Redis, Temporal)

### 2. Install dependencies

From repository root:

```bash
npm install
```

### 3. Configure environment

Create `.env` in repository root from `.env.example` and set real Auth0 values.

Required runtime keys:

- `PORT=4001`
- `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agentcantdothat`
- `TEMPORAL_ADDRESS=localhost:7233`
- `TEMPORAL_NAMESPACE=default`
- `CFO_USER_ID=<auth0 user id>`
- `DPO_USER_ID=<auth0 user id>`
- Auth0 client and audience settings for Token Vault/CIBA

Console URL config is in `apps/console/.env.local`:

```bash
NEXT_PUBLIC_API_URL=http://localhost:4001
```

### 4. Start infrastructure

```bash
npm run infra:up
```

This starts:

- PostgreSQL on `5432`
- Redis on `6379`
- Temporal on `7233`
- Temporal UI on `8080`

### 5. Start services

Use separate terminals:

Terminal A (API):

```bash
npm run dev:api
```

Terminal B (Worker):

```bash
npm run dev:worker
```

Terminal C (Console):

```bash
npm run dev:console
```

If port `3000` is already in use, Next.js will move to `3001` automatically.

### 6. Health checks

- API: `http://localhost:4001/api/health`
- Console: `http://localhost:3000` (or `http://localhost:3001` if auto-shifted)

### 7. Demo run (full thesis flow)

1. Start a workflow from the console homepage.
2. Confirm low-risk actions log first:
	- `revoke_sso_access_completed`
	- `billing_history_exported`
	- `subscriptions_cancelled`
3. Confirm pre-block competence sequence:
	- `customer_validation_passed`
	- `data_stores_enumerated`
	- `compliance_check_passed`
4. Confirm first high-risk block.
5. Trigger escalation + CFO approval path for refund.
6. Consume/revoke refund authority window.
7. Confirm second block for deletion (no authority carry-forward).
8. Trigger DPO approval path for deletion.
9. Consume/revoke deletion authority window.
10. Confirm final ledger includes `cross_action_propagation_check_passed`.

Example verified workflow id:

- `offboarding-final-e2e-002-1774177327353`

### 8. Stop infrastructure

```bash
npm run infra:down
```

Sandbox and safety note:
- Demo mode uses sandbox integrations only.
- No real funds are moved.
- No real customer data is deleted.

---

## Related Documents

- Product requirements: [PRD.md](PRD.md)
- Architecture decisions: [ADR.md](ADR.md)
