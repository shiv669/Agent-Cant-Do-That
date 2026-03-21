# Architecture Decision Records (ADR)

Status legend:
- Proposed: discussed, not finalized
- Accepted: approved baseline
- Superseded: replaced by newer ADR

---

## ADR-001: Use Auth0 Token Vault as the Authorization Control Plane

- Status: Accepted
- Date: 2026-03-21

### Context
The system must enforce per-action authority windows for irreversible actions. The hackathon requires Token Vault to be load-bearing, and judges expect real authorization boundaries, not simulated UI checks.

### Decision
Adopt Auth0 for AI Agents with Token Vault as the authority issuance and enforcement backbone, combined with MFA for step-up approval and role-based approver constraints.

### Consequences
Positive:
- Direct alignment with hackathon requirements
- Strongest judge-facing credibility for real deny, issue, consume, revoke lifecycle
- Reduced security implementation risk versus custom token-vault logic

Negative:
- Vendor dependency on Auth0 capabilities and service behavior
- Integration constraints shaped by Auth0 product model

### Alternatives Considered
- Custom in-house authority vault: rejected due to security and timeline risk
- Generic OAuth provider without Token Vault-equivalent controls: rejected due to weaker fit for per-action non-replay windows
- RBAC-only implementation: rejected because persistent role grants do not model one-time authority windows

---

## ADR-002: Use Temporal for Durable Workflow Orchestration

- Status: Accepted
- Date: 2026-03-21

### Context
The offboarding flow is multi-step, long-running, and includes human-in-the-loop approvals and failure-prone external calls. We need deterministic state progression and audit-ready execution history.

### Decision
Use Temporal workflows (TypeScript SDK) to orchestrate process state, retries, waits, approvals, and terminal outcomes.

### Consequences
Positive:
- Durable execution and resume-after-failure behavior
- Strong support for human approval checkpoints
- Clear event history for audit and incident replay

Negative:
- Additional platform component to operate
- Team must follow deterministic workflow coding rules

### Alternatives Considered
- Celery or queue-only orchestration: rejected due to weaker long-running workflow semantics and state determinism
- Cron plus queue composition: rejected due to orchestration sprawl and higher failure ambiguity
- LangGraph as primary runtime: rejected for primary orchestration because problem is authorization-workflow infrastructure first, not LLM reasoning first

---

## ADR-003: Use a TypeScript-First Application Stack (NestJS + Next.js)

- Status: Accepted
- Date: 2026-03-21

### Context
We need rapid delivery, clear modular boundaries, and consistent domain model handling across UI, API, and workflow integrations.

### Decision
Use NestJS for backend APIs and domain services, and Next.js App Router for the operations console.

### Consequences
Positive:
- Single-language stack across UI, API, and Temporal integration
- Strong backend modularity and testability for policy-critical services
- Fast internal console delivery with production-ready web primitives
- Mitigation for timeline risk: use a constrained NestJS pattern set (module/service/controller + guards) and avoid non-essential framework complexity during MVP

Negative:
- Heavier framework learning curve than minimal frameworks
- Runtime tied to Node.js ecosystem conventions

### Alternatives Considered
- FastAPI backend with TS frontend: rejected due to split-language operational overhead for this timeline
- Express plus React from scratch: rejected due to weaker structure and more custom scaffolding for policy-critical modules

---

## ADR-004: Use PostgreSQL as System of Record with Append-Only Authority Ledger

- Status: Accepted
- Date: 2026-03-21

### Context
Authority lifecycle integrity requires strict transactional guarantees and immutable audit traces.

### Decision
Use PostgreSQL as primary data store. Implement authority ledger as append-only events and enforce one-time claim plus TTL checks with database constraints and transactional logic.

### Consequences
Positive:
- ACID guarantees for critical authority transitions
- Strong relational integrity across workflows, approvals, and actions
- Robust querying for compliance and post-incident audit

Negative:
- Requires careful schema design for event growth and partition strategy
- Migration discipline needed for immutable ledger contracts

### Alternatives Considered
- MongoDB as primary ledger store: rejected due to weaker fit for strict relational invariants and transactional policy guarantees
- Kafka-first event source: rejected for current scope due to operational overhead and slower hackathon delivery

---

## ADR-005: Use Redis for Ephemeral Coordination, Not as Source of Truth

- Status: Accepted
- Date: 2026-03-21

### Context
Low-latency ephemeral state may be needed for short-lived coordination, but authority integrity cannot depend on volatile storage.

### Decision
Use Redis only for cache and ephemeral coordination. Never store final authority truth, consumed status truth, or immutable ledger truth in Redis.

Allowed Redis use in MVP:
- real-time workflow status fan-out to the operations console
- short-lived read-model cache for non-authoritative UI performance

### Consequences
Positive:
- Improved responsiveness for non-critical transient state
- Clean separation of performance layer from integrity layer

Negative:
- Additional component to secure and operate
- Cache invalidation strategy needed

### Alternatives Considered
- No cache: rejected due to potential avoidable latency in operational UI and status fan-out
- Redis as primary authority source: rejected due to durability and auditability risk

---

## ADR-006: Use OpenTelemetry for End-to-End Observability

- Status: Accepted
- Date: 2026-03-21

### Context
Demo credibility depends on proving real request-response behavior across authorization deny, approval, mint, consume, revoke, and replay rejection.

### Decision
Instrument services with OpenTelemetry traces, metrics, and logs and export via OTLP to a compatible backend.

### Consequences
Positive:
- Vendor-neutral observability standard
- Strong cross-service causal visibility for demo and debugging
- Better incident triage and audit support
- Demo credibility support: traces can be surfaced during demo review (console trace panel or observability dashboard)

Negative:
- Instrumentation overhead and telemetry cost management needed

### Alternatives Considered
- Ad hoc logs only: rejected as insufficient for distributed causality
- Vendor-specific-only instrumentation: rejected to avoid lock-in and portability limits

---

## ADR-007: Enforce Fail-Closed Authorization Behavior

- Status: Accepted
- Date: 2026-03-21

### Context
Any ambiguity in authorization checks for irreversible actions creates unacceptable security risk.

### Decision
If authority verification is unavailable, expired, or inconsistent, deny execution and record a blocked event. Do not allow best-effort execution.

### Consequences
Positive:
- Security posture remains consistent under partial outages
- Behavior is explicit, testable, and auditable

Negative:
- Possible temporary user friction during dependency outages

### Alternatives Considered
- Fail-open fallback for availability: rejected due to irreversible action risk
- Silent retry without user-visible block state: rejected due to audit transparency requirements

---

## ADR-008: Scope MVP to One Primary Workflow with Two Irreversible Actions

- Status: Accepted
- Date: 2026-03-21

### Context
Hackathon success depends on depth and proof quality, not breadth of domain scenarios.

### Decision
MVP includes enterprise customer offboarding with two irreversible actions:
- Refund requiring CFO approval
- Permanent deletion requiring DPO approval

### Consequences
Positive:
- Maximum clarity of thesis in minimal, judge-comprehensible flow
- Higher implementation quality on core mechanism under timeline constraints

Negative:
- Limited domain breadth in initial release

### Alternatives Considered
- Multiple parallel use cases in MVP: rejected due to dilution risk and execution complexity
- Single irreversible action only: rejected because it under-demonstrates non-propagation across sequential high-risk steps

---

## ADR-009: Bind Authority Windows to Specific Agent Identity

- Status: Accepted
- Date: 2026-03-21

### Context
The architecture uses multiple agents/sub-agents. A core guarantee requires that only the intended agent can claim a given authority window for execution.

### Decision
Authority windows are issued with explicit binding attributes:
- target agent identity
- permitted action scope
- workflow/action reference

At claim time, the claimant identity must match the bound target identity and scope, or claim is denied and logged.

### Consequences
Positive:
- Prevents orchestrator or sibling agents from claiming windows not intended for them
- Makes "non-transferable authority" enforceable at runtime, not policy-only
- Strengthens forensic clarity in ledger and traces

Negative:
- Requires strict machine identity management and credential rotation discipline
- Adds validation checks to critical path of execution claim

### Alternatives Considered
- Scope-only window without agent binding: rejected because any same-scope agent could attempt claim
- Orchestrator-mediated claims on behalf of child agents: rejected because it weakens separation and enables implicit authority laundering

---

## ADR-010: Role-to-Action Approval Routing Model

- Status: Accepted
- Date: 2026-03-21

### Context
The system requires different approvers for different irreversible actions (e.g., CFO for refund, DPO for deletion). Routing cannot be ad hoc.

### Decision
Define an explicit role-to-action routing policy table (or policy config) with:
- action scope
- required approver role(s)
- escalation/backup rules
- timeout behavior

Step-up approval requests are routed strictly by this policy. If no eligible approver is available, action remains blocked and event is logged.

### Consequences
Positive:
- Deterministic, auditable approver selection
- Clear governance separation between financial and data-risk actions
- Easier policy updates without code-path ambiguity

Negative:
- Requires policy management lifecycle and ownership
- Needs operational process for approver unavailability

### Alternatives Considered
- Hardcoded approver in workflow code: rejected due to poor maintainability and weak governance
- First-available approver regardless of role: rejected because it violates risk segregation requirements

---

## Review Cadence

- ADR review trigger points:
  - New irreversible action type introduced
  - New external system added to execution path
  - Identity provider or workflow runtime change proposed
  - Compliance requirements materially change

- Owner:
  - Architecture owner and security owner jointly approve any ADR status changes.