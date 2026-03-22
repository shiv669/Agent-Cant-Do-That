export type ActionScope =
  | 'orchestrate:customer_offboarding'
  | 'execute:refund'
  | 'execute:data_deletion';

export type LedgerEventType =
  | 'high_risk_action_blocked'
  | 'authorization_blocked'
  | 'unauthorized_escalation_attempt_recorded'
  | 'authority_window_requested'
  | 'authority_window_issued'
  | 'authority_window_claimed'
  | 'authority_window_claim_accepted'
  | 'authority_window_consumed'
  | 'authority_token_revoked'
  | 'replay_attempt_blocked'
  | 'cross_action_propagation_denied';

export type WorkflowStatus =
  | 'pending'
  | 'running'
  | 'blocked-awaiting-authority'
  | 'completed'
  | 'failed';

export interface StartOffboardingInput {
  customerId: string;
}

export interface WorkflowStatusResponse {
  workflowId: string;
  status: WorkflowStatus;
}

export interface LedgerEvent {
  seqId: number;
  workflowId: string;
  eventType: LedgerEventType;
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface StartOffboardingResponse extends WorkflowStatusResponse {
  customerId: string;
}

export interface HighRiskAuthorityCheckInput {
  workflowId: string;
  actionScope: Extract<ActionScope, 'execute:refund' | 'execute:data_deletion'>;
  authorityWindowToken?: string;
}

export interface EscalationAttemptInput extends HighRiskAuthorityCheckInput {
  reason?: string;
}

export interface AuthorityCheckResponse {
  workflowId: string;
  actionScope: Extract<ActionScope, 'execute:refund' | 'execute:data_deletion'>;
  authority: 'granted' | 'denied';
}

export type AuthorityWindowStatus = 'requested' | 'claimed' | 'consumed' | 'revoked' | 'expired';

export interface AuthorityWindowRequestInput {
  workflowId: string;
  actionScope: Extract<ActionScope, 'execute:refund' | 'execute:data_deletion'>;
  boundAgentClientId: string;
  ttlSeconds?: number;
}

export interface AuthorityWindowRequestResponse {
  windowId: string;
  workflowId: string;
  actionScope: Extract<ActionScope, 'execute:refund' | 'execute:data_deletion'>;
  boundAgentClientId: string;
  expiresAt: string;
  status: AuthorityWindowStatus;
}

export interface AuthorityWindowClaimInput {
  windowId: string;
  claimantAgentClientId: string;
}

export interface AuthorityWindowClaimResponse {
  windowId: string;
  workflowId: string;
  actionScope: Extract<ActionScope, 'execute:refund' | 'execute:data_deletion'>;
  claimantAgentClientId: string;
  status: AuthorityWindowStatus;
  authorityWindowToken: string;
  expiresAt: string;
}

export interface AuthorityWindowConsumeInput {
  windowId: string;
  claimantAgentClientId: string;
}

export interface AuthorityWindowConsumeResponse {
  windowId: string;
  workflowId: string;
  actionScope: Extract<ActionScope, 'execute:refund' | 'execute:data_deletion'>;
  status: AuthorityWindowStatus;
}

export interface AuthorityWindowReplayAttemptInput {
  windowId: string;
  claimantAgentClientId: string;
}
