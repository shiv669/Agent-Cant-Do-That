'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AuthorityWindowClaimResponse,
  AuthorityWindowRequestResponse,
  LedgerEvent,
  StartOffboardingResponse,
  WorkflowStatusResponse
} from '@contracts/index';

const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4001';
const POLL_INTERVAL_MS = 800;

type UIState = 'idle' | 'executing' | 'complete';
type HighRiskAction = 'execute:refund' | 'execute:data_deletion';

type WindowInfo = {
  windowId: string;
  actionScope: HighRiskAction;
  expiresAt?: string;
};

type ClaimByScope = Partial<Record<HighRiskAction, AuthorityWindowClaimResponse>>;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function toTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleTimeString('en-GB', { hour12: false });
}

function countdown(expiresAt?: string, nowMs?: number): string {
  if (!expiresAt || !nowMs) return '--:--';
  const remaining = new Date(expiresAt).getTime() - nowMs;
  if (remaining <= 0) return '00:00';
  const seconds = Math.floor(remaining / 1000);
  const mm = Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0');
  const ss = (seconds % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

function eventLabel(event: LedgerEvent): string {
  const payload = asRecord(event.payload);
  if (event.eventType === 'high_risk_action_blocked') {
    const scope = String(payload.actionScope ?? '');
    if (scope === 'execute:refund') {
      return 'execution blocked: missing scope execute:refund';
    }
    if (scope === 'execute:data_deletion') {
      return 'execution blocked: missing scope execute:data_deletion';
    }
  }

  if (event.eventType === 'unauthorized_escalation_attempt_recorded') {
    return 'ESCALATION_ATTEMPT_RECORDED';
  }

  return event.eventType.toUpperCase();
}

function eventTone(event: LedgerEvent): string {
  if (event.eventType === 'high_risk_action_blocked' || event.eventType === 'replay_attempt_blocked') {
    return 'text-red-300';
  }

  if (event.eventType === 'unauthorized_escalation_attempt_recorded') {
    return 'text-red-200';
  }

  if (
    event.eventType === 'step_up_approved' ||
    event.eventType === 'authority_window_claimed' ||
    event.eventType === 'authority_window_consumed' ||
    event.eventType === 'authority_token_revoked' ||
    event.eventType.endsWith('_completed')
  ) {
    return 'text-emerald-300';
  }

  return 'text-slate-200';
}

function eventIcon(event: LedgerEvent): string {
  if (event.eventType === 'high_risk_action_blocked' || event.eventType === 'replay_attempt_blocked') return '[x]';
  if (event.eventType === 'unauthorized_escalation_attempt_recorded') return '[!]';
  if (
    event.eventType === 'step_up_requested' ||
    event.eventType === 'authority_window_requested' ||
    event.eventType === 'authority_window_issued'
  ) {
    return '[>]';
  }

  return '[+]';
}

export default function HomePage() {
  const [uiState, setUiState] = useState<UIState>('idle');
  const [customerId, setCustomerId] = useState('ENT-00441');
  const [workflowId, setWorkflowId] = useState('');
  const [workflowStatus, setWorkflowStatus] = useState<WorkflowStatusResponse | null>(null);
  const [events, setEvents] = useState<LedgerEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isRequestingAuthority, setIsRequestingAuthority] = useState(false);
  const [isExecutingAction, setIsExecutingAction] = useState(false);
  const [claimsByScope, setClaimsByScope] = useState<ClaimByScope>({});
  const [nowMs, setNowMs] = useState(Date.now());

  const blockRequestedRef = useRef<{ refund: boolean; deletion: boolean }>({ refund: false, deletion: false });

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!workflowId) return;

    let active = true;

    const fetchState = async () => {
      try {
        const [statusResponse, ledgerResponse] = await Promise.all([
          fetch(`${apiBase}/api/workflows/${workflowId}/status`, { cache: 'no-store' }),
          fetch(`${apiBase}/api/authority/ledger/${workflowId}`, { cache: 'no-store' })
        ]);

        if (!active) return;

        if (statusResponse.ok) {
          const statusData = (await statusResponse.json()) as WorkflowStatusResponse;
          setWorkflowStatus(statusData);
        }

        if (!ledgerResponse.ok) {
          throw new Error(`Failed to load ledger (${ledgerResponse.status})`);
        }

        const ledgerData = (await ledgerResponse.json()) as LedgerEvent[];
        setEvents(ledgerData);
        setError(null);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Failed to load live execution state');
      }
    };

    void fetchState();
    const interval = setInterval(() => {
      void fetchState();
    }, POLL_INTERVAL_MS);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [workflowId]);

  const windowsById = useMemo(() => {
    const map = new Map<string, WindowInfo>();

    for (const event of events) {
      if (event.eventType !== 'authority_window_requested') continue;
      const payload = asRecord(event.payload);
      const windowId = typeof payload.windowId === 'string' ? payload.windowId : '';
      const scope = payload.actionScope;

      if (!windowId || (scope !== 'execute:refund' && scope !== 'execute:data_deletion')) continue;

      map.set(windowId, {
        windowId,
        actionScope: scope,
        expiresAt: typeof payload.expiresAt === 'string' ? payload.expiresAt : undefined
      });
    }

    return map;
  }, [events]);

  const hasRefundBlock = useMemo(() => {
    return events.some((event) => {
      if (event.eventType !== 'high_risk_action_blocked') return false;
      const payload = asRecord(event.payload);
      return payload.actionScope === 'execute:refund';
    });
  }, [events]);

  const hasDeletionBlock = useMemo(() => {
    return events.some((event) => {
      if (event.eventType !== 'high_risk_action_blocked') return false;
      const payload = asRecord(event.payload);
      return payload.actionScope === 'execute:data_deletion';
    });
  }, [events]);

  const hasRefundConsumed = useMemo(() => {
    return events.some((event) => {
      if (event.eventType !== 'authority_window_consumed') return false;
      const payload = asRecord(event.payload);
      return payload.actionScope === 'execute:refund';
    });
  }, [events]);

  const hasDeletionConsumed = useMemo(() => {
    return events.some((event) => {
      if (event.eventType !== 'authority_window_consumed') return false;
      const payload = asRecord(event.payload);
      return payload.actionScope === 'execute:data_deletion';
    });
  }, [events]);

  const activeAction = useMemo<HighRiskAction | null>(() => {
    if (!hasRefundConsumed) return 'execute:refund';
    if (!hasDeletionConsumed) return 'execute:data_deletion';
    return null;
  }, [hasDeletionConsumed, hasRefundConsumed]);

  const latestWindowByScope = useMemo(() => {
    const latest: Partial<Record<HighRiskAction, WindowInfo>> = {};
    for (const event of events) {
      if (event.eventType !== 'authority_window_requested') continue;
      const payload = asRecord(event.payload);
      const windowId = typeof payload.windowId === 'string' ? payload.windowId : '';
      const scope = payload.actionScope;
      if (!windowId || (scope !== 'execute:refund' && scope !== 'execute:data_deletion')) continue;
      latest[scope] = windowsById.get(windowId);
    }

    return latest;
  }, [events, windowsById]);

  const sidebarScope = activeAction;
  const sidebarWindow = sidebarScope ? latestWindowByScope[sidebarScope] : undefined;
  const sidebarClaim = sidebarScope ? claimsByScope[sidebarScope] : undefined;

  const isAwaitingApproval = useMemo(() => {
    if (!sidebarScope) return false;

    const hasRequest = events.some((event) => {
      if (event.eventType !== 'step_up_requested') return false;
      const payload = asRecord(event.payload);
      return payload.actionScope === sidebarScope;
    });

    const hasApproval = events.some((event) => {
      if (event.eventType !== 'step_up_approved') return false;
      const payload = asRecord(event.payload);
      return payload.actionScope === sidebarScope;
    });

    return hasRequest && !hasApproval;
  }, [events, sidebarScope]);

  useEffect(() => {
    if (!workflowId) return;

    const lowRiskDone = events.some((event) => event.eventType === 'compliance_check_passed');
    if (!lowRiskDone) return;

    if (!blockRequestedRef.current.refund && !hasRefundBlock) {
      blockRequestedRef.current.refund = true;
      void triggerRealBlock('execute:refund');
    }

    if (hasRefundConsumed && !blockRequestedRef.current.deletion && !hasDeletionBlock) {
      blockRequestedRef.current.deletion = true;
      void triggerRealBlock('execute:data_deletion');
    }
  }, [events, hasDeletionBlock, hasRefundBlock, hasRefundConsumed, workflowId]);

  useEffect(() => {
    if (hasDeletionConsumed) {
      setUiState('complete');
    }
  }, [hasDeletionConsumed]);

  const startWorkflow = async () => {
    setError(null);
    setIsStarting(true);

    try {
      const response = await fetch(`${apiBase}/api/workflows/offboarding/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-agent-client-id': 'orchestrator-a'
        },
        body: JSON.stringify({ customerId })
      });

      if (!response.ok) {
        throw new Error(`Failed to start workflow (${response.status})`);
      }

      const payload = (await response.json()) as StartOffboardingResponse;
      setWorkflowId(payload.workflowId);
      setWorkflowStatus({ workflowId: payload.workflowId, status: payload.status });
      setClaimsByScope({});
      setEvents([]);
      blockRequestedRef.current = { refund: false, deletion: false };
      setUiState('executing');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to start workflow');
    } finally {
      setIsStarting(false);
    }
  };

  const triggerRealBlock = async (scope: HighRiskAction) => {
    if (!workflowId) return;

    try {
      await fetch(`${apiBase}/api/authority/high-risk/check`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-agent-client-id': 'subagent-d-only'
        },
        body: JSON.stringify({
          workflowId,
          actionScope: scope
        })
      });
    } catch {
      // Denied block checks are expected and captured in backend ledger.
    }
  };

  const requestTemporaryAuthority = async (scope: HighRiskAction) => {
    if (!workflowId) return;

    setError(null);
    setIsRequestingAuthority(true);

    try {
      await fetch(`${apiBase}/api/authority/escalate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-agent-client-id': 'orchestrator-a'
        },
        body: JSON.stringify({
          workflowId,
          actionScope: scope,
          reason: 'Temporary authority requested by operator'
        })
      });

      const requestResponse = await fetch(`${apiBase}/api/authority/window/request`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-agent-client-id': 'orchestrator-a'
        },
        body: JSON.stringify({
          workflowId,
          customerId,
          actionScope: scope,
          boundAgentClientId: 'subagent-d-only',
          amount: scope === 'execute:refund' ? 82450 : undefined,
          ttlSeconds: 120
        })
      });

      if (!requestResponse.ok) {
        throw new Error(`Authority request failed (${requestResponse.status})`);
      }

      const request = (await requestResponse.json()) as AuthorityWindowRequestResponse;

      const claimResponse = await fetch(`${apiBase}/api/authority/window/claim`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-agent-client-id': 'subagent-d-only'
        },
        body: JSON.stringify({
          windowId: request.windowId
        })
      });

      if (!claimResponse.ok) {
        throw new Error(`Authority claim failed (${claimResponse.status})`);
      }

      const claim = (await claimResponse.json()) as AuthorityWindowClaimResponse;
      setClaimsByScope((prev) => ({
        ...prev,
        [scope]: claim
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authority request failed');
    } finally {
      setIsRequestingAuthority(false);
    }
  };

  const executeAction = async (scope: HighRiskAction) => {
    const claim = claimsByScope[scope];
    if (!claim) return;

    setError(null);
    setIsExecutingAction(true);

    try {
      const response = await fetch(`${apiBase}/api/authority/window/consume`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-agent-client-id': 'subagent-d-only'
        },
        body: JSON.stringify({
          windowId: claim.windowId
        })
      });

      if (!response.ok) {
        throw new Error(`Execution failed (${response.status})`);
      }

      setClaimsByScope((prev) => {
        const next = { ...prev };
        delete next[scope];
        return next;
      });

      if (scope === 'execute:refund') {
        await triggerRealBlock('execute:data_deletion');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Execution failed');
    } finally {
      setIsExecutingAction(false);
    }
  };

  if (uiState === 'complete') {
    return (
      <main className="min-h-screen bg-slate-900 px-6 py-6 text-slate-100">
        <section className="mx-auto max-w-6xl">
          <header className="border border-slate-700 bg-slate-800 px-4 py-3">
            <h1 className="font-sans text-xl font-semibold tracking-wide">AUTHORITY LEDGER (APPEND-ONLY)</h1>
            <p className="mt-1 font-mono text-xs text-slate-300">workflow_id={workflowId}</p>
          </header>

          <div className="mt-3 space-y-1 font-mono text-sm">
            {events.map((event) => (
              <article key={`${event.workflowId}-${event.seqId}`} className="grid grid-cols-[90px_90px_300px_1fr] border border-slate-700 bg-slate-950 px-3 py-2">
                <span className="text-slate-300">#{String(event.seqId).padStart(4, '0')}</span>
                <span className="text-slate-400">{toTime(event.createdAt)}</span>
                <span className={eventTone(event)}>{event.eventType.toUpperCase()}</span>
                <span className="text-slate-200">{eventLabel(event)}</span>
              </article>
            ))}
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-900 px-6 py-8 text-slate-100">
      <section className="mx-auto max-w-7xl">
        {uiState === 'idle' ? (
          <div className="grid gap-4 border border-slate-700 bg-slate-800 p-6 md:grid-cols-2">
            <div className="space-y-3">
              <h1 className="font-sans text-2xl font-semibold">Operations Console</h1>
              <p className="font-mono text-sm text-slate-300">customer_id: {customerId}</p>
              <p className="font-mono text-sm text-slate-300">account_type: enterprise</p>
              <p className="font-mono text-sm text-slate-300">contract_end: 2026-06-30</p>
              <p className="font-mono text-sm text-slate-300">data_stores: 14</p>
              <p className="font-mono text-sm text-slate-300">authorized_scope: orchestrate:customer_offboarding</p>
            </div>

            <div className="space-y-3">
              <label className="block font-sans text-sm">Customer ID</label>
              <input
                className="w-full border border-slate-600 bg-slate-900 px-3 py-2 font-mono text-sm text-slate-100"
                onChange={(event) => setCustomerId(event.target.value)}
                value={customerId}
              />
              <button
                className="border border-slate-500 bg-slate-700 px-4 py-2 font-sans text-sm disabled:opacity-50"
                disabled={isStarting || !customerId}
                onClick={() => {
                  void startWorkflow();
                }}
                type="button"
              >
                {isStarting ? 'INITIATING...' : 'INITIATE OFFBOARDING'}
              </button>
              {error ? <p className="font-mono text-xs text-red-300">{error}</p> : null}
            </div>
          </div>
        ) : null}

        {uiState === 'executing' ? (
          <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
            <div className="border border-slate-700 bg-slate-800 p-4">
              <header className="mb-3 border-b border-slate-700 pb-3">
                <h2 className="font-sans text-lg font-semibold">Execution Feed</h2>
                <p className="mt-1 font-mono text-xs text-slate-300">workflow_id: {workflowId}</p>
                <p className="font-mono text-xs text-slate-400">status: {workflowStatus?.status ?? 'loading'}</p>
              </header>

              <div className="max-h-[68vh] space-y-1 overflow-y-auto font-mono text-sm">
                {events.map((event) => (
                  <div key={`${event.workflowId}-${event.seqId}`} className="grid grid-cols-[34px_70px_1fr] border-b border-slate-700/60 py-1">
                    <span className={eventTone(event)}>{eventIcon(event)}</span>
                    <span className="text-slate-400">{toTime(event.createdAt)}</span>
                    <span className={eventTone(event)}>{eventLabel(event)}</span>
                  </div>
                ))}
                {hasRefundConsumed && hasDeletionBlock ? (
                  <div className="grid grid-cols-[34px_70px_1fr] border-b border-slate-700/60 py-1">
                    <span className="text-red-200">[!]</span>
                    <span className="text-slate-400">{toTime(new Date().toISOString())}</span>
                    <span className="text-red-200">refund approval does not carry forward</span>
                  </div>
                ) : null}
              </div>

              {error ? <p className="mt-3 font-mono text-xs text-red-300">{error}</p> : null}
            </div>

            <aside className="border border-slate-700 bg-slate-800 p-4">
              <h3 className="font-sans text-sm font-semibold uppercase tracking-wide text-slate-200">Step-Up Authority</h3>

              {sidebarScope ? (
                <div className="mt-3 space-y-2 font-mono text-xs text-slate-300">
                  <p>action: {sidebarScope}</p>
                  <p>amount: {sidebarScope === 'execute:refund' ? '$82,450' : 'n/a'}</p>
                  <p>approver: {sidebarScope === 'execute:refund' ? 'CFO' : 'DPO'}</p>
                  <p>ttl: {countdown(sidebarClaim?.expiresAt ?? sidebarWindow?.expiresAt, nowMs)}</p>
                  <p>status: {isAwaitingApproval ? 'Awaiting approval...' : sidebarClaim ? 'Token issued' : 'Blocked'}</p>

                  {!sidebarClaim ? (
                    <button
                      className="mt-2 w-full border border-slate-500 bg-slate-700 px-3 py-2 font-sans text-xs disabled:opacity-50"
                      disabled={isRequestingAuthority || isExecutingAction || (!hasRefundBlock && sidebarScope === 'execute:refund') || (!hasDeletionBlock && sidebarScope === 'execute:data_deletion')}
                      onClick={() => {
                        void requestTemporaryAuthority(sidebarScope);
                      }}
                      type="button"
                    >
                      {isRequestingAuthority ? 'REQUESTING...' : 'REQUEST TEMPORARY AUTHORITY'}
                    </button>
                  ) : (
                    <button
                      className="mt-2 w-full border border-slate-500 bg-slate-700 px-3 py-2 font-sans text-xs disabled:opacity-50"
                      disabled={isExecutingAction}
                      onClick={() => {
                        void executeAction(sidebarScope);
                      }}
                      type="button"
                    >
                      {isExecutingAction ? 'EXECUTING...' : sidebarScope === 'execute:refund' ? 'EXECUTE REFUND' : 'EXECUTE DATA DELETION'}
                    </button>
                  )}
                </div>
              ) : (
                <p className="mt-3 font-mono text-xs text-slate-400">No active high-risk action.</p>
              )}
            </aside>
          </div>
        ) : null}
      </section>
    </main>
  );
}
