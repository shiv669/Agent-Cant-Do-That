type SupportedAction =
  | 'revoke_access'
  | 'export_billing_history'
  | 'cancel_subscriptions'
  | 'validate_customer_state'
  | 'enumerate_data_stores'
  | 'run_compliance_check'
  | 'execute_refund'
  | 'execute_data_deletion';

const apiBase = process.env.API_BASE_URL?.trim() || 'http://localhost:4001';

async function postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-request-id': `temporal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    },
    body: JSON.stringify(body)
  });

  const payload = (await response.json().catch(() => ({}))) as T & { reason?: string; message?: string };
  if (!response.ok) {
    throw new Error(
      `Activity call failed (${path}) status=${response.status} reason=${payload.reason ?? payload.message ?? 'unknown'}`
    );
  }

  return payload;
}

export async function planNextAction(input: {
  workflowId: string;
  customerId: string;
  refundAmountUsd: number;
}): Promise<{
  nextAction: SupportedAction;
  reasoning: string;
  actionReason: string;
  completedActions: string[];
}> {
  return postJson('/api/workflows/internal/plan-next', input);
}

export async function executeActionStep(input: {
  workflowId: string;
  customerId: string;
  action: SupportedAction;
  refundAmountUsd: number;
  opsSubjectToken?: string;
  completedActions?: string[];
}): Promise<{ action: SupportedAction; blocked: boolean; completed: boolean }> {
  return postJson('/api/workflows/internal/execute-step', input);
}
