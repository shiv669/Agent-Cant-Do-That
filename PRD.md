# Product Requirements Document (PRD)

## Product
**Agent Can't Do That**

## 1) Product Idea
Build an authorization-first control layer for multi-agent systems where **authority is attached to each irreversible action**, not inherited from an orchestrator or parent agent.

The product demonstrates a strict principle:
- Agents can orchestrate workflows.
- Agents cannot execute high-risk irreversible actions unless a human issues a fresh, action-scoped authorization window.
- Authorization is single-use and non-transferable.

Core thesis:
> Authorization is an event lifecycle (create → claim → consume → destroy), not a persistent permission state.

## 2) How It Should Work

### 2.1 Operating Model
1. A human operator authorizes an orchestrator for a bounded orchestration scope: `orchestrate:customer_offboarding`.
2. The orchestrator can run low-risk tasks and delegate execution steps.
3. Any high-risk action request from a sub-agent must fetch a new execution-scoped authority artifact with explicit action scope (for MVP: `execute:refund` or `execute:data_deletion`).
4. If no valid artifact exists, backend returns a real denial response (403), and execution is blocked.
5. Human step-up approval (role-specific approver) issues an authority window with strict TTL.
6. Sub-agent claims the window once, executes exactly one scoped action, and the window is burned immediately.
7. Token is revoked post-execution and cannot be replayed.
8. Next high-risk action requires a new independent authority window, even within the same workflow.

### 2.2 Authorization Rules
- No authority inheritance from orchestrator to sub-agents for irreversible actions.
- No authority carry-forward from one irreversible action to another.
- No replay of consumed authorization windows.
- No transfer of authority artifacts between agents.
- Every denial, escalation attempt, approval, mint, consume, and revoke is audit-logged.

### 2.3 Reference Workflow (Enterprise Customer Offboarding)
Low-risk steps execute directly:
- Revoke SSO access
- Export billing history
- Cancel subscriptions

High-risk steps enforce hard authorization windows:
- Refund execution requires CFO step-up approval.
- Permanent data deletion requires DPO step-up approval.

Expected behavior sequence:
- First high-risk attempt is blocked (`403`).
- Step-up approval grants a short-lived authority window.
- Action executes once; authority is consumed and revoked.
- Second high-risk action is blocked again until a different role approves.

## 3) Expected Output

### 3.1 System Output (Runtime)
- Real API denial on unauthorized high-risk attempts (`403`).
- Real token mint only after valid human step-up approval.
- Immediate post-execution revocation confirmation.
- Replay attempts rejected.
- Unauthorized escalation/override attempts are captured as explicit ledger events and persisted.

### 3.2 User-Facing Output
- Clear hard-stop state for unauthorized irreversible actions.
- Step-up approval status tied to approver identity and action type.
- Final immutable authority ledger as the terminal screen.

### 3.3 Authority Ledger Output (Required Fields)
- Orchestrator authorizer identity
- Orchestrator scope
- Action attempt status (success/blocked)
- Escalation attempt status (including unauthorized attempts)
- Escalation event type (must include `unauthorized_escalation_attempt_recorded`)
- Approver identity per high-risk action
- Authority window TTL
- Token/window lifecycle states (minted, consumed, revoked)
- Replay status
- Cross-action authority propagation check (must show authority from action N does not authorize action N+1)
- Explicit statement that authority propagation to sub-agents is none

### 3.4 Success Criteria
- System blocks unauthorized irreversible actions every time.
- Human approvals are action-specific and role-specific.
- Approval for one high-risk action does not authorize the next.
- Ledger provides complete, immutable traceability of all authority events.
- Demo success condition: when a judge attempts override during a blocked high-risk action, the final ledger must show that exact unauthorized attempt as a permanent recorded event without requiring additional explanation.

### 3.5 UX Constraint for Unauthorized Override Attempts
- Unauthorized override/escalation attempts must be silently recorded to the ledger.
- The system must not present extra warning/scolding UI in response to the attempt beyond normal blocked-state behavior and final ledger evidence.

## 4) Recommended Tech Stack

### 4.1 Final Stack
- **Identity + Authorization Core:** Auth0 for AI Agents + Token Vault + Auth0 MFA + RBAC
- **Workflow Runtime:** Temporal (TypeScript SDK)
- **Backend/API Layer:** NestJS (TypeScript)
- **Frontend Console:** Next.js (App Router, TypeScript)
- **Primary Data Store:** PostgreSQL (append-only authority ledger + relational domain state)
- **Cache / Short-Lived Coordination:** Redis
- **Observability:** OpenTelemetry + OTLP-compatible backend (Grafana stack or equivalent)
- **Deployment Target:** Dockerized services for hackathon; managed cloud deployment for demo

## 5) Architecture (How Components Work Together)

1. User operates internal console in Next.js.
2. API requests are handled by NestJS.
3. Long-running offboarding process is executed by Temporal workflow.
4. Each high-risk step requests action-scoped authority through Auth0 Token Vault.
5. Missing/invalid authority returns real denial; workflow transitions to blocked state.
6. Step-up approval is triggered via Auth0 MFA for role-specific approver (e.g., CFO, DPO) on a separate physical device.
7. On approval, authority window is issued with strict TTL; worker claims once and executes one action.
8. Authority is consumed/revoked; replay attempts are denied.
9. All transitions are persisted in PostgreSQL append-only ledger and emitted as telemetry traces/logs.

### 5.1 MFA Approval Payload Requirements
- MFA prompt payload must include business context required for verifier confidence:
	- customer/vendor reference
	- action type
	- financial amount (if applicable)
	- request/case identifier
- Approval prompt details on device must match the console panel details for the same approval event.

## 6) Data Model Requirements (Authority Integrity)

Required tables (minimum):
- `authority_windows`
- `authority_claims`
- `workflow_actions`
- `approval_events`
- `authority_ledger_events` (append-only)

Hard constraints:
- One-time claim constraint per authority window.
- TTL enforcement at execution time.
- Immutable ledger records (no updates/deletes in event table).
- Explicit parent-child action linkage for traceability.

## 7) Non-Functional Requirements

- **Security:** all high-risk actions must fail closed on auth service uncertainty.
- **Reliability:** workflows survive service restarts without losing authority state.
- **Auditability:** every deny/approve/claim/consume/revoke is queryable.
- **Latency targets:** deny decision under 300ms p95 for authorization check path (excluding human step-up).
- **Replay resistance:** consumed or expired windows are always rejected.

## 8) Delivery Strategy

### 8.1 Hackathon Scope (MVP)
- Single tenant
- One primary use case (customer offboarding)
- Two irreversible actions (refund, deletion)
- Real Auth0 integration for step-up and token lifecycle
- Immutable ledger UI as final screen
- Ledger integrity baseline in MVP: append-only rows with immutable insertion timestamp and monotonic sequence ID for tamper-evident ordering

### 8.2 Post-Hackathon Hardening
- Multi-tenant boundaries
- Policy simulation mode
- Cryptographic hash chaining for ledger rows
- Segregated worker pools per risk class

## 9) Decision Traceability

Detailed decision rationale and alternatives are documented in [ADR.md](ADR.md).

Implementation must conform to accepted decisions in:
- ADR-001 (Auth0 Token Vault as control plane)
- ADR-002 (Temporal orchestration)
- ADR-003 (TypeScript-first app stack)
- ADR-004 (PostgreSQL append-only ledger)
- ADR-005 (Redis as ephemeral layer)
- ADR-006 (OpenTelemetry observability)
- ADR-007 (fail-closed behavior)
- ADR-008 (MVP scope boundaries)
- ADR-009 (authority window agent identity binding)
- ADR-010 (role-to-action approval routing)