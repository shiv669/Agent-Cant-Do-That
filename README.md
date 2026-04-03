![Agent Can't Do That](./ACDT_LOGO.png)

# Agent Can't Do That

Authorization at execution time for AI agents.

---

## What this project shows

An AI agent prepared an `$82,000` refund and a permanent deletion across multiple systems.

It knew exactly what to do.

It could not execute either action.

This system enforces that behavior.

---

## The problem

In most systems, agents are given persistent access.

Once that access exists, execution becomes a matter of calling an API.

This creates risk when agents reach irreversible actions like:

- financial transactions  
- data deletion  

There is no strong boundary at the moment execution happens.

---

## The approach

This system removes persistent access entirely for high-risk actions.

Instead:

- Authorization is created only when an action is about to run  
- It is validated at that moment  
- It is removed immediately after execution  

Each action is evaluated independently.

Approval for one action does not apply to another.

---

## What happens in the system

### Workflow start

- The **Operations Manager** must approve the workflow  
- Without this, nothing executes  

---

### Low-risk actions

The agent executes routine steps automatically:

- Revoke access  
- Export billing data  
- Cancel subscriptions  

These actions execute automatically without additional approval.

Credentials are issued only at execution time using Auth0 Token Vault and are not reused.

---

### High-risk actions

When the agent reaches:

- Refund → requires **CFO approval**  
- Data deletion → requires **DPO approval**

If approval is missing:

- The backend rejects the request with a **403**  
- The action does not execute  

When approval is granted:

- A one-time authorization is created  
- The agent claims and uses it immediately  
- It is consumed and cannot be reused  

---

### No carry-forward

- Approval for refund does not apply to deletion  
- Each action requires its own authorization  
- There is no persistent permission  

---

### Final state

The system produces a complete ledger of:

- Executed actions  
- Blocked actions  
- Authorization lifecycle (issued → consumed)  

This record comes directly from backend execution, not UI simulation.

---

## System guarantees

- No persistent access for irreversible actions  
- Authorization is per-action and single-use  
- No reuse or replay of authorization  
- No carry-forward across actions  
- Backend-enforced execution checks  
- Immutable, append-only audit ledger  

---

## Architecture

- **Auth0 for AI Agents**
  - CIBA for role-based approval flows  
  - Token Vault for issuing credentials at execution time  

- **Workflow Engine**
  - Temporal for orchestrating execution with durable state  

- **Backend**
  - NestJS API enforcing authorization at each step  

- **Frontend**
  - Next.js console visualizing live execution  

- **Data Layer**
  - PostgreSQL append-only ledger tracking authorization lifecycle  

- **Observability**
  - OpenTelemetry tracing  

---

## Why Auth0 matters here

- CIBA separates human approval from execution  
- Token Vault ensures credentials exist only at execution time  
- Together, they enable execution-time authorization without persistent access  

---

## How to verify

Run the deployed system and observe:

1. Workflow does not start without Operations Manager approval  
2. Low-risk actions execute automatically  
3. High-risk actions are blocked with a backend 403 without approval  
4. Approval creates a single-use authorization  
5. Authorization is consumed immediately after execution  
6. Second high-risk action is blocked again (no carry-forward)  
7. Ledger reflects all decisions and actions  

---

## Developer notes

- Authorization is enforced in backend execution paths  
- UI reflects system state only  
- Workflow state is durable via Temporal  
- Credentials are never stored for reuse  

---

## Setup (local)

### Prerequisites

- Node.js 20+  
- Docker  

### Install

    npm install

### Start infrastructure

    npm run infra:up

### Run services

    npm run dev:api
    npm run dev:worker
    npm run dev:console

---

## Demo notes

- Demo mode simulates approval interaction  
- Backend enforcement remains unchanged  
- No real financial or destructive actions are performed  

---

## Related docs

- [PRD.md](PRD.md)  
- [ADR.md](ADR.md)