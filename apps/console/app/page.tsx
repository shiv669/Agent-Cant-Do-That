'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import type {
  AuthorityWindowClaimResponse,
  AuthorityWindowRequestResponse,
  LedgerEvent,
  StartOffboardingResponse,
  WorkflowStatusResponse
} from '@contracts/index';

const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4001';

type HighRiskAction = 'execute:refund' | 'execute:data_deletion';

type ActionUiState = {
  escalationRecorded: boolean;
  awaitingStepUp: boolean;
  requestExpiresAt: string | null;
  claim: AuthorityWindowClaimResponse | null;
  executeComplete: boolean;
};

const emptyActionState: ActionUiState = {
  escalationRecorded: false,
  awaitingStepUp: false,
  requestExpiresAt: null,
  claim: null,
  executeComplete: false
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function countdownFrom(expiresAt: string | undefined, nowMs: number): string {
  if (!expiresAt) return '--:--';
  const remainingMs = new Date(expiresAt).getTime() - nowMs;
  if (remainingMs <= 0) return '00:00';
  const total = Math.floor(remainingMs / 1000);
  const mm = Math.floor(total / 60).toString().padStart(2, '0');
  const ss = (total % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

const progressionSteps = [
  {
    eventType: 'revoke_sso_access_completed',
    pending: 'REVOKING SSO ACCESS...',
    done: 'SSO ACCESS REVOKED        ✓'
  },
  {
    eventType: 'billing_history_exported',
    pending: 'EXPORTING BILLING HISTORY...',
    done: 'BILLING HISTORY EXPORTED  ✓'
  },
  {
    eventType: 'subscriptions_cancelled',
    pending: 'CANCELLING SUBSCRIPTIONS...',
    done: 'SUBSCRIPTIONS CANCELLED   ✓'
  },
  {
    eventType: 'customer_validation_passed',
    pending: 'VALIDATING CUSTOMER...',
    done: '✓ Customer ENT-00441 active'
  },
  {
    eventType: 'data_stores_enumerated',
    pending: 'ENUMERATING DATA STORES...',
    done: '✓ 14 stores identified'
  },
  {
    eventType: 'compliance_check_passed',
    pending: 'CHECKING COMPLIANCE...',
    done: '✓ No holds, cleared'
  }
] as const;

export default function HomePage() {
  const router = useRouter();
  const [customerId, setCustomerId] = useState('ENT-00441');
  const [isLoading, setIsLoading] = useState(false);
  const [isEscalating, setIsEscalating] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [startResult, setStartResult] = useState<StartOffboardingResponse | null>(null);
  const [status, setStatus] = useState<WorkflowStatusResponse | null>(null);
  const [ledger, setLedger] = useState<LedgerEvent[]>([]);
  const [uiStatus, setUiStatus] = useState<string>('idle');
  const [nowMs, setNowMs] = useState(Date.now());
  const [panelAction, setPanelAction] = useState<HighRiskAction | null>(null);
  const [actionStates, setActionStates] = useState<Record<HighRiskAction, ActionUiState>>({
    'execute:refund': { ...emptyActionState },
    'execute:data_deletion': { ...emptyActionState }
  });
  const [error, setError] = useState<string | null>(null);

  const workflowId = useMemo(() => startResult?.workflowId ?? '', [startResult]);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!workflowId) return;

    let active = true;

    const fetchLedger = async () => {
      try {
        const response = await fetch(`${apiBase}/api/authority/ledger/${workflowId}`, { cache: 'no-store' });
        if (!response.ok) {
          throw new Error(`Ledger load failed (${response.status})`);
        }

        const data = (await response.json()) as LedgerEvent[];
        if (!active) return;
        setLedger(data);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Failed to load ledger updates');
      }
    };

    fetchLedger();
    const poll = setInterval(fetchLedger, 3000);

    return () => {
      active = false;
      clearInterval(poll);
    };
  }, [workflowId]);

  const startWorkflow = async () => {
    setError(null);
    setIsLoading(true);

    try {
      const response = await fetch(`${apiBase}/api/workflows/offboarding/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId })
      });

      if (!response.ok) {
        throw new Error(`Start failed (${response.status})`);
      }

      const data = (await response.json()) as StartOffboardingResponse;
      setStartResult(data);
      setStatus({ workflowId: data.workflowId, status: data.status });
      setUiStatus(data.status);
      setActionStates({
        'execute:refund': { ...emptyActionState },
        'execute:data_deletion': { ...emptyActionState }
      });
      setPanelAction(null);

      const ledgerResponse = await fetch(`${apiBase}/api/authority/ledger/${data.workflowId}`);
      if (ledgerResponse.ok) {
        setLedger((await ledgerResponse.json()) as LedgerEvent[]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoading(false);
    }
  };

  const refreshStatus = async () => {
    if (!workflowId) return;

    const response = await fetch(`${apiBase}/api/workflows/${workflowId}/status`);
    if (response.ok) {
      setStatus((await response.json()) as WorkflowStatusResponse);
    }

    const ledgerResponse = await fetch(`${apiBase}/api/authority/ledger/${workflowId}`);
    if (ledgerResponse.ok) {
      setLedger((await ledgerResponse.json()) as LedgerEvent[]);
    }
  };

  const stepCompletion = useMemo(() => {
    return progressionSteps.map((step) => ledger.some((event) => event.eventType === step.eventType));
  }, [ledger]);

  const highestCompletedIndex = stepCompletion.lastIndexOf(true);
  const firstBlockEvent = useMemo(() => {
    return ledger.find((event) => event.eventType === 'high_risk_action_blocked' && asRecord(event.payload).actionScope === 'execute:refund');
  }, [ledger]);

  const secondBlockEvent = useMemo(() => {
    return ledger.find(
      (event) => event.eventType === 'high_risk_action_blocked' && asRecord(event.payload).actionScope === 'execute:data_deletion'
    );
  }, [ledger]);

  const deletionConsumed = useMemo(() => {
    return ledger.some(
      (event) => event.eventType === 'authority_window_consumed' && asRecord(event.payload).actionScope === 'execute:data_deletion'
    );
  }, [ledger]);

  const activeAction = useMemo<HighRiskAction | null>(() => {
    if (deletionConsumed) return null;
    if (secondBlockEvent) return 'execute:data_deletion';
    if (firstBlockEvent) return 'execute:refund';
    return null;
  }, [deletionConsumed, firstBlockEvent, secondBlockEvent]);

  const requestEscalationAndStepUp = async (action: HighRiskAction) => {
    if (!workflowId) return;

    setError(null);
    setUiStatus('awaiting-step-up-approval');
    setPanelAction(action);
    setIsEscalating(true);
    setActionStates((prev) => ({
      ...prev,
      [action]: {
        ...prev[action],
        escalationRecorded: true,
        awaitingStepUp: true
      }
    }));

    try {
      await fetch(`${apiBase}/api/authority/escalate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowId, actionScope: action })
      });

      const requestBody = {
        workflowId,
        customerId,
        actionScope: action,
        requestingAgentClientId: 'orchestrator-a',
        boundAgentClientId: 'subagent-d-only',
        amount: action === 'execute:refund' ? 82450 : undefined,
        ttlSeconds: 120
      };

      const requestResponse = await fetch(`${apiBase}/api/authority/window/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      if (!requestResponse.ok) {
        throw new Error(`Step-up request failed (${requestResponse.status})`);
      }

      const requestData = (await requestResponse.json()) as AuthorityWindowRequestResponse;

      setActionStates((prev) => ({
        ...prev,
        [action]: {
          ...prev[action],
          requestExpiresAt: requestData.expiresAt
        }
      }));

      const claimResponse = await fetch(`${apiBase}/api/authority/window/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ windowId: requestData.windowId, claimantAgentClientId: 'subagent-d-only' })
      });

      if (!claimResponse.ok) {
        throw new Error(`Window claim failed (${claimResponse.status})`);
      }

      const claimData = (await claimResponse.json()) as AuthorityWindowClaimResponse;

      setActionStates((prev) => ({
        ...prev,
        [action]: {
          ...prev[action],
          awaitingStepUp: false,
          claim: claimData
        }
      }));
      setUiStatus('authority-window-received');
    } catch (err) {
      setActionStates((prev) => ({
        ...prev,
        [action]: {
          ...prev[action],
          awaitingStepUp: false
        }
      }));
      setError(err instanceof Error ? err.message : 'Failed to complete step-up flow');
    } finally {
      setIsEscalating(false);
    }
  };

  const executeHighRiskAction = async (action: HighRiskAction) => {
    const claim = actionStates[action].claim;
    if (!claim) return;

    setError(null);
    setIsExecuting(true);
    try {
      const consumeResponse = await fetch(`${apiBase}/api/authority/window/consume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ windowId: claim.windowId, claimantAgentClientId: 'subagent-d-only' })
      });

      if (!consumeResponse.ok) {
        throw new Error(`Execution consume failed (${consumeResponse.status})`);
      }

      setActionStates((prev) => ({
        ...prev,
        [action]: {
          ...prev[action],
          executeComplete: true,
          claim: null
        }
      }));
      setUiStatus('execution-complete');

      if (action === 'execute:refund') {
        await fetch(`${apiBase}/api/authority/high-risk/check`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workflowId, actionScope: 'execute:data_deletion' })
        });
      }

      if (action === 'execute:data_deletion') {
        router.push(`/ledger/${workflowId}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to execute action');
    } finally {
      setIsExecuting(false);
    }
  };

  const activeActionState = activeAction ? actionStates[activeAction] : null;
  const panelActionState = panelAction ? actionStates[panelAction] : null;
  const showStepUpPanel = Boolean(panelAction && panelActionState?.escalationRecorded);
  const hasEscalationLine = actionStates['execute:refund'].escalationRecorded || actionStates['execute:data_deletion'].escalationRecorded;
  const blockMessage = activeAction === 'execute:data_deletion'
    ? 'Authority window absent - data deletion blocked'
    : 'Authority window absent - execution blocked';

  return (
    <main className="min-h-screen bg-background px-6 py-10">
      <div className="mx-auto max-w-4xl space-y-6">
        <h1 className="text-3xl font-semibold text-primary">Agent Can&apos;t Do That</h1>
        <p className="text-base text-slate-700">Vertical slice: start offboarding → Temporal workflow trigger → status + ledger event.</p>

        <div className="space-y-3 rounded border border-secondary bg-white p-4">
          <label className="block text-sm font-medium text-primary" htmlFor="customerId">
            Customer ID
          </label>
          <input
            id="customerId"
            className="w-full rounded border border-secondary px-3 py-2"
            value={customerId}
            onChange={(event) => setCustomerId(event.target.value)}
          />

          <div className="flex gap-3">
            <button
              className="rounded border border-primary px-4 py-2 text-primary disabled:opacity-50"
              disabled={isLoading || !customerId}
              onClick={startWorkflow}
            >
              {isLoading ? 'Starting...' : 'Start Offboarding'}
            </button>
            <button className="rounded border border-secondary px-4 py-2 text-primary" disabled={!workflowId} onClick={refreshStatus}>
              Refresh Status
            </button>
            <Link className="inline-block rounded border border-primary px-4 py-2 text-primary" href="/demo">
              Open Demo Screen
            </Link>
          </div>
        </div>

        {error ? <div className="rounded border border-danger bg-red-50 p-3 text-sm text-danger">{error}</div> : null}

        {startResult ? (
          <div className="rounded border border-secondary bg-white p-4">
            <h2 className="mb-2 text-lg font-semibold text-primary">Workflow</h2>
            <p className="text-sm text-slate-700">
              <strong>ID:</strong> {startResult.workflowId}
            </p>
            <p className="text-sm text-slate-700">
              <strong>Status:</strong> {uiStatus === 'idle' ? status?.status ?? startResult.status : uiStatus}
            </p>

            <div className="mt-4 space-y-2 rounded border border-secondary_light bg-slate-50 p-3 font-mono text-sm">
              {progressionSteps.map((step, index) => {
                if (index > highestCompletedIndex + 1) {
                  return null;
                }

                const complete = stepCompletion[index];
                return (
                  <p key={step.eventType} className={complete ? 'whitespace-pre text-emerald-700' : 'whitespace-pre text-slate-700'}>
                    {complete ? step.done : step.pending}
                  </p>
                );
              })}
            </div>

            {activeAction ? (
              <div className="mt-4 bg-slate-900 px-4 py-3 font-mono text-sm text-rose-200">
                <p>████████████████████████████████</p>
                <p>AGENT CAN&apos;T DO THAT</p>
                <p>{blockMessage}</p>
                <p>████████████████████████████████</p>
              </div>
            ) : null}

            {activeAction ? (
              <button
                className="mt-3 text-left text-sm text-slate-700"
                disabled={isEscalating || Boolean(activeActionState?.executeComplete)}
                onClick={() => requestEscalationAndStepUp(activeAction)}
                type="button"
              >
                Request temporary execution authority for this agent →
              </button>
            ) : null}

            {showStepUpPanel && panelActionState ? (
              <div className="mt-4 rounded border border-secondary_light bg-slate-50 p-3 text-sm text-slate-800">
                {panelActionState.awaitingStepUp ? (
                  <div className="space-y-1">
                    <p>Action: {panelAction === 'execute:refund' ? 'Cross-border refund execution' : 'Cross-border data deletion execution'}</p>
                    <p>Customer: {customerId}</p>
                    <p>Amount: {panelAction === 'execute:refund' ? '$82,450' : 'N/A'}</p>
                    <p>Required approver: {panelAction === 'execute:refund' ? 'CFO' : 'DPO'}</p>
                    <p>Status: Step-up dispatched</p>
                    <p>Authority window expires: {countdownFrom(panelActionState.requestExpiresAt ?? undefined, nowMs)}</p>
                  </div>
                ) : null}

                {!panelActionState.awaitingStepUp && panelActionState.claim ? (
                  <div className="space-y-2">
                    <p>Authority window received</p>
                    <p>Scope: {panelActionState.claim.actionScope}</p>
                    <p>Token TTL: 120 seconds</p>
                    <p>Bound to: subagent-d only</p>
                    <p>&quot;This authority cannot be transferred, extended, or reused.&quot;</p>
                    {!panelActionState.executeComplete ? (
                      <button
                        className="rounded border border-primary px-4 py-2 text-primary"
                        disabled={isExecuting}
                        onClick={() => {
                          if (panelAction) {
                            void executeHighRiskAction(panelAction);
                          }
                        }}
                        type="button"
                      >
                        {panelAction === 'execute:refund' ? 'Execute Refund' : 'Execute Deletion'}
                      </button>
                    ) : null}
                  </div>
                ) : null}

                {panelActionState.executeComplete ? <p>Execution complete. Authority consumed.</p> : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {ledger.length > 0 ? (
          <div className="rounded border border-secondary bg-white p-4">
            <h2 className="mb-3 text-lg font-semibold text-primary">Ledger Events</h2>
            {hasEscalationLine ? (
              <p className="mb-2 text-sm text-slate-600">Escalation attempt recorded</p>
            ) : null}
            <div className="space-y-2">
              {ledger.map((event) => (
                <div key={`${event.workflowId}-${event.seqId}`} className="rounded border border-secondary_light p-3 text-sm">
                  <p>
                    <strong>Seq:</strong> {event.seqId} | <strong>Type:</strong> {event.eventType}
                  </p>
                  <p>
                    <strong>At:</strong> {event.createdAt}
                  </p>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </main>
  );
}
