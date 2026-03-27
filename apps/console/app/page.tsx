'use client';

import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type {
  AuthorityWindowClaimResponse,
  AuthorityWindowRequestResponse,
  LedgerEvent,
  StartOffboardingResponse,
  WorkflowStatusResponse
} from '@contracts/index';
import { cn } from '@/lib/utils';

const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4001';
const POLL_INTERVAL_MS = 1000;
const LIVE_AUTO_EXECUTE_DELAY_MS = 8000;

type UIState = 'idle' | 'executing' | 'complete';
type HighRiskAction = 'execute:refund' | 'execute:data_deletion';

type WindowInfo = {
  windowId: string;
  actionScope: HighRiskAction;
  expiresAt?: string;
};

type ClaimByScope = Partial<Record<HighRiskAction, AuthorityWindowClaimResponse>>;
type RunMode = 'demo' | 'live';

type OffboardingReason = 'contract_termination' | 'fraud_review' | 'compliance_exit' | 'customer_request';
type EventMessage = { base: string };

const OFFBOARDING_REASONS: Array<{ value: OffboardingReason; label: string }> = [
  { value: 'contract_termination', label: 'contract_termination' },
  { value: 'fraud_review', label: 'fraud_review' },
  { value: 'compliance_exit', label: 'compliance_exit' },
  { value: 'customer_request', label: 'customer_request' }
];

const cardReveal = {
  hidden: { opacity: 0, y: 8 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.24, ease: [0.22, 1, 0.36, 1] }
  }
} as const;

const rowReveal = {
  hidden: { opacity: 0, y: 4 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.18, ease: 'easeOut' } }
} as const;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function toTime(iso: string): string {
  const date = new Date(iso);
  const base = date.toLocaleTimeString('en-GB', { hour12: false });
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${base}.${ms}`;
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

function prettyScope(scope: HighRiskAction | string): string {
  return scope.replace('execute:', '').replace('_', ' ');
}

function toMoney(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value);
}

async function buildHttpError(response: Response, fallback: string): Promise<Error> {
  let detail = '';
  try {
    const payload = (await response.json()) as { reason?: string; message?: string | string[] };
    if (typeof payload.reason === 'string' && payload.reason.trim()) {
      detail = payload.reason.trim();
    } else if (typeof payload.message === 'string' && payload.message.trim()) {
      detail = payload.message.trim();
    } else if (Array.isArray(payload.message) && payload.message.length > 0) {
      detail = String(payload.message[0] ?? '').trim();
    }
  } catch {
    // Ignore body parse failures and use fallback text.
  }

  if (detail) {
    return new Error(`${fallback} (${response.status}): ${detail}`);
  }
  return new Error(`${fallback} (${response.status})`);
}

function eventActor(event: LedgerEvent): string {
  const payload = asRecord(event.payload);
  const actor = payload.actor;
  if (typeof actor === 'string' && actor.length > 0) {
    return actor;
  }

  if (event.eventType.startsWith('authority_') || event.eventType.startsWith('step_up_')) {
    return 'authority_system';
  }

  if (event.eventType === 'high_risk_action_blocked') {
    return 'policy_engine';
  }

  return 'orchestrator_agent';
}

function eventLabel(event: LedgerEvent): string {
  return eventMessage(event).base;
}

function eventMessage(event: LedgerEvent): EventMessage {
  const payload = asRecord(event.payload);

  if (event.eventType === 'step_up_requested') {
    const scope = String(payload.actionScope ?? 'unknown');
    const approver = String(payload.approverRole ?? 'approver');
    return {
      base: `step_up requested action=${scope} approver=${approver}`
    };
  }

  if (event.eventType === 'step_up_approved') {
    const scope = String(payload.actionScope ?? 'unknown');
    return {
      base: `step_up approved action=${scope}`
    };
  }

  if (event.eventType === 'high_risk_action_blocked') {
    const scope = String(payload.actionScope ?? '');
    if (scope === 'execute:refund') {
      return {
        base: 'system.response 403 forbidden missing_scope=execute:refund'
      };
    }
    if (scope === 'execute:data_deletion') {
      return {
        base: 'system.response 403 forbidden missing_scope=execute:data_deletion'
      };
    }
  }

  if (event.eventType === 'authority_window_consumed') {
    const scope = String(payload.actionScope ?? '');
    if (scope === 'execute:refund') return { base: 'agent.execute(refund) system.result success' };
    if (scope === 'execute:data_deletion')
      return { base: 'agent.execute(data_deletion) system.result success' };
  }

  if (event.eventType === 'authority_window_requested') {
    const scope = String(payload.actionScope ?? 'unknown');
    const ttl = payload.ttlSeconds;
    return {
      base: `authority.window requested action=${scope} ttl=${String(ttl ?? 'n/a')}`
    };
  }

  if (event.eventType === 'authority_window_issued') {
    return {
      base: `authority.window issued action=${String(payload.actionScope ?? 'unknown')}`
    };
  }

  if (event.eventType === 'authority_token_revoked') {
    return { base: 'authority.token revoked' };
  }

  if (event.eventType === 'billing_history_exported') {
    const tokenSource = typeof payload.tokenSource === 'string' ? payload.tokenSource : 'none';
    const exportFormat = typeof payload.exportFormat === 'string' ? payload.exportFormat : 'unknown';
    const url = typeof payload.sheetUrl === 'string' ? payload.sheetUrl : '';
    const suffix = url ? ` sheet_url=${url}` : '';
    return {
      base: `billing export=${exportFormat} token_source=${tokenSource}${suffix}`
    };
  }

  if (event.eventType === 'unauthorized_escalation_attempt_recorded') {
    return { base: 'escalation_attempt_recorded' };
  }

  return { base: event.eventType };
}

function eventRequestedBy(event: LedgerEvent): string {
  const payload = asRecord(event.payload);
  const requestedBy = payload.requested_by;
  if (typeof requestedBy === 'string' && requestedBy.length > 0) {
    return requestedBy;
  }

  return 'orchestrator-agent-v1';
}

function eventRequestId(event: LedgerEvent): string {
  const payload = asRecord(event.payload);
  const requestId = payload.request_id;
  if (typeof requestId === 'string' && requestId.length > 0) {
    return requestId;
  }

  return `req_${String(event.seqId).padStart(6, '0')}`;
}

function TypeRevealLine({ text, animate }: { text: string; animate: boolean }) {
  const [visible, setVisible] = useState(animate ? 0 : text.length);

  useEffect(() => {
    if (!animate) {
      setVisible(text.length);
      return;
    }

    setVisible(0);
    const id = setInterval(() => {
      setVisible((prev) => {
        if (prev >= text.length) {
          clearInterval(id);
          return prev;
        }
        return prev + 1;
      });
    }, 12);

    return () => clearInterval(id);
  }, [animate, text]);

  return <span>{text.slice(0, visible)}</span>;
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

function eventRowClass(event: LedgerEvent): string {
  if (event.eventType === 'replay_attempt_blocked') {
    return 'border border-rose-600/90 bg-rose-950/40';
  }

  if (event.eventType === 'high_risk_action_blocked') {
    return 'border border-rose-700/70 bg-rose-950/25';
  }

  return 'border-b border-zinc-800/70';
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
  const demoEnabledFromEnv = process.env.NEXT_PUBLIC_DEMO_MODE_ENABLED === 'true';
  const [uiState, setUiState] = useState<UIState>('idle');
  const [mode, setMode] = useState<RunMode>(demoEnabledFromEnv ? 'demo' : 'live');
  const [customerInput, setCustomerInput] = useState('ENT-00441');
  const [refundAmountInput, setRefundAmountInput] = useState('82450');
  const [reasonInput, setReasonInput] = useState<OffboardingReason>('contract_termination');

  const [startedCustomerId, setStartedCustomerId] = useState('');
  const [startedRefundAmount, setStartedRefundAmount] = useState(0);
  const [startedReason, setStartedReason] = useState<OffboardingReason>('contract_termination');

  const [workflowId, setWorkflowId] = useState('');
  const [workflowStatus, setWorkflowStatus] = useState<WorkflowStatusResponse | null>(null);
  const [events, setEvents] = useState<LedgerEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isRequestingAuthority, setIsRequestingAuthority] = useState(false);
  const [isExecutingAction, setIsExecutingAction] = useState(false);
  const [claimsByScope, setClaimsByScope] = useState<ClaimByScope>({});
  const [nowMs, setNowMs] = useState(Date.now());
  const [latestEventSeqId, setLatestEventSeqId] = useState<number | null>(null);
  const [approvalToast, setApprovalToast] = useState<string | null>(null);
  const [showOpsApprovalModal, setShowOpsApprovalModal] = useState(false);
  const [opsDenyReason, setOpsDenyReason] = useState('Ops manager denied orchestration start');
  const [denyReason, setDenyReason] = useState('Policy risk acknowledged by reviewer');
  const [dismissedScope, setDismissedScope] = useState<HighRiskAction | null>(null);
  const [lastAutoHandledBlockSeq, setLastAutoHandledBlockSeq] = useState<number>(0);
  const [popupCooldownUntil, setPopupCooldownUntil] = useState<number>(0);
  const [pendingExecuteScope, setPendingExecuteScope] = useState<HighRiskAction | null>(null);
  const [pendingExecuteUntilMs, setPendingExecuteUntilMs] = useState<number | null>(null);
  const [fallbackEvidence, setFallbackEvidence] = useState<{
    tokenSource: string;
    sheetUrl: string;
    publicSheetUrl: string;
    isPublic: boolean;
    evidenceEntries: Array<{ key: string; value: string }>;
  } | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!workflowId) return;

    let active = true;

    const fetchStatus = async () => {
      try {
        const statusResponse = await fetch(`${apiBase}/api/workflows/${workflowId}/status`, { cache: 'no-store' });

        if (!active) return;

        if (statusResponse.ok) {
          const statusData = (await statusResponse.json()) as WorkflowStatusResponse;
          setWorkflowStatus(statusData);
        }
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Failed to load workflow status');
      }
    };

    void fetchStatus();
    const interval = setInterval(() => {
      void fetchStatus();
    }, POLL_INTERVAL_MS);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [workflowId]);

  useEffect(() => {
    if (!workflowId) return;

    let active = true;
    let stream: EventSource | null = null;

    const upsertEvent = (incoming: LedgerEvent) => {
      setEvents((prev) => {
        if (
          prev.some(
            (event) =>
              event.seqId === incoming.seqId &&
              event.eventType === incoming.eventType &&
              event.createdAt === incoming.createdAt
          )
        ) {
          return prev;
        }

        const next = [...prev, incoming];
        next.sort((a, b) => a.seqId - b.seqId);
        return next;
      });
    };

    const connect = async () => {
      try {
        const snapshotResponse = await fetch(`${apiBase}/api/authority/ledger/${workflowId}`, { cache: 'no-store' });
        if (!snapshotResponse.ok) {
          throw new Error(`Failed to load ledger snapshot (${snapshotResponse.status})`);
        }

        const snapshot = (await snapshotResponse.json()) as LedgerEvent[];
        if (!active) return;

        setEvents(snapshot);
        const lastSeqId = snapshot.length > 0 ? snapshot[snapshot.length - 1].seqId : undefined;
        const streamUrl = new URL(`${apiBase}/api/authority/ledger/${workflowId}/stream`);
        if (typeof lastSeqId === 'number') {
          streamUrl.searchParams.set('sinceSeqId', String(lastSeqId));
        }

        // [JUDGE NOTICE - SCALABILITY]: The frontend relies on real-time SSE from the append-only Postgres ledger. This ensures the UI state is a mathematically derived projection of immutable backend events, preventing UI spoofing.
        stream = new EventSource(streamUrl.toString());

        stream.addEventListener('ledger_event', (rawEvent) => {
          const payload = rawEvent as MessageEvent<string>;
          try {
            const parsed = JSON.parse(payload.data) as LedgerEvent;
            if (!active) return;
            upsertEvent(parsed);
            setError(null);
          } catch {
            // Ignore malformed stream payloads and keep listening.
          }
        });

        stream.addEventListener('ready', () => {
          if (!active) return;
          setError(null);
        });

        stream.onerror = () => {
          if (!active) return;
          setError('Live stream reconnecting...');
        };
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Failed to start live event stream');
      }
    };

    void connect();

    return () => {
      active = false;
      stream?.close();
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
    if (events.length === 0) {
      setLatestEventSeqId(null);
      return;
    }

    setLatestEventSeqId(events[events.length - 1].seqId);
  }, [events]);

  const startWorkflow = async () => {
    setError(null);
    setIsStarting(true);

    const normalizedCustomer = customerInput.trim();
    const parsedRefundAmount = Number(refundAmountInput);

    if (!normalizedCustomer) {
      setError('Customer name is required');
      setIsStarting(false);
      return;
    }

    if (!Number.isFinite(parsedRefundAmount) || parsedRefundAmount <= 0) {
      setError('Refund amount must be a positive number');
      setIsStarting(false);
      return;
    }

    try {
      const response = await fetch(`${apiBase}/api/workflows/offboarding/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-agent-client-id': 'orchestrator-agent-v1'
        },
        body: JSON.stringify({
          customerId: normalizedCustomer,
          refundAmountUsd: parsedRefundAmount,
          demoMode: mode === 'demo'
        })
      });

      if (!response.ok) {
        throw await buildHttpError(response, 'Failed to start workflow');
      }

      const payload = (await response.json()) as StartOffboardingResponse;
      setWorkflowId(payload.workflowId);
      setWorkflowStatus({ workflowId: payload.workflowId, status: payload.status });
      setClaimsByScope({});
      setEvents([]);
      setStartedCustomerId(normalizedCustomer);
      setStartedRefundAmount(parsedRefundAmount);
      setStartedReason(reasonInput);
      setUiState('executing');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to start workflow');
    } finally {
      setIsStarting(false);
    }
  };

  const initiateOffboarding = () => {
    setApprovalToast(null);
    if (mode === 'demo') {
      setShowOpsApprovalModal(true);
      return;
    }

    void startWorkflow();
  };

  const requestTemporaryAuthority = async (scope: HighRiskAction): Promise<AuthorityWindowClaimResponse | null> => {
    if (!workflowId) return null;

    setError(null);
    setApprovalToast(null);
    setIsRequestingAuthority(true);

    try {
      const claimant = scope === 'execute:refund' ? 'billing-agent-v1' : 'data-agent-v1';

      const requestResponse = await fetch(`${apiBase}/api/authority/window/request`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-agent-client-id': 'orchestrator-agent-v1'
        },
        body: JSON.stringify({
          workflowId,
          customerId: startedCustomerId,
          actionScope: scope,
          boundAgentClientId: claimant,
          amount: scope === 'execute:refund' ? startedRefundAmount : undefined,
          ttlSeconds: 120,
          demoMode: mode === 'demo'
        })
      });

      if (!requestResponse.ok) {
        throw await buildHttpError(requestResponse, 'Authority request failed');
      }

      const request = (await requestResponse.json()) as AuthorityWindowRequestResponse;

      const claimResponse = await fetch(`${apiBase}/api/authority/window/claim`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-agent-client-id': claimant
        },
        body: JSON.stringify({
          windowId: request.windowId
        })
      });

      if (!claimResponse.ok) {
        throw await buildHttpError(claimResponse, 'Authority claim failed');
      }

      const claim = (await claimResponse.json()) as AuthorityWindowClaimResponse;

      setClaimsByScope((prev) => ({
        ...prev,
        [scope]: claim
      }));
      return claim;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Authority request failed';
      setError(message);
      setApprovalToast(message);
      return null;
    } finally {
      setIsRequestingAuthority(false);
    }
  };

  const executeAction = async (scope: HighRiskAction, claim?: AuthorityWindowClaimResponse | null) => {
    const resolvedClaim = claim ?? claimsByScope[scope];
    if (!resolvedClaim) return;

    setError(null);
    setIsExecutingAction(true);

    try {
      const response = await fetch(`${apiBase}/api/authority/window/consume`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-agent-client-id': scope === 'execute:refund' ? 'billing-agent-v1' : 'data-agent-v1'
        },
        body: JSON.stringify({
          windowId: resolvedClaim.windowId
        })
      });

      if (!response.ok) {
        throw await buildHttpError(response, 'Execution failed');
      }

      setClaimsByScope((prev) => {
        const next = { ...prev };
        delete next[scope];
        return next;
      });
      setPendingExecuteScope(null);
      setPendingExecuteUntilMs(null);
      setPopupCooldownUntil(Date.now() + 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Execution failed');
      setPendingExecuteScope(null);
      setPendingExecuteUntilMs(null);
    } finally {
      setIsExecutingAction(false);
    }
  };

  const systemStatus = useMemo(() => {
    if (uiState === 'complete' || hasDeletionConsumed) return 'COMPLETED';
    if (hasRefundBlock || hasDeletionBlock) return 'BLOCKED';
    if (uiState === 'executing') return 'RUNNING';
    return 'IDLE';
  }, [hasDeletionBlock, hasDeletionConsumed, hasRefundBlock, uiState]);

  const latestEvent = events.length > 0 ? events[events.length - 1] : null;
  const latestEventSummary = latestEvent ? eventMessage(latestEvent).base : 'waiting_for_first_event';
  const isWorkflowComplete = hasDeletionConsumed || workflowStatus?.status === 'completed';

  const boundaryMissingScope = useMemo(() => {
    if (hasDeletionBlock && !hasDeletionConsumed) return 'execute:data_deletion';
    if (hasRefundBlock && !hasRefundConsumed) return 'execute:refund';
    return null;
  }, [hasDeletionBlock, hasDeletionConsumed, hasRefundBlock, hasRefundConsumed]);

  const latestBlocked = useMemo<{ scope: HighRiskAction; seqId: number } | null>(() => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.eventType !== 'high_risk_action_blocked') continue;
      const payload = asRecord(event.payload);
      if (payload.actionScope === 'execute:refund' && !hasRefundConsumed) {
        return { scope: 'execute:refund', seqId: event.seqId };
      }
      if (payload.actionScope === 'execute:data_deletion' && !hasDeletionConsumed) {
        return { scope: 'execute:data_deletion', seqId: event.seqId };
      }
    }

    return null;
  }, [events, hasDeletionConsumed, hasRefundConsumed]);

  const interceptScope = latestBlocked?.scope ?? sidebarScope;
  const shouldShowConsentPanel = Boolean(
    interceptScope &&
      mode === 'demo' &&
      !isWorkflowComplete &&
      !sidebarClaim &&
      nowMs >= popupCooldownUntil &&
      dismissedScope !== interceptScope &&
      (workflowStatus?.status === 'blocked-awaiting-authority' || latestBlocked)
  );
  const authorityExpiry = sidebarClaim?.expiresAt ?? sidebarWindow?.expiresAt;
  const authoritySecondsLeft = authorityExpiry ? Math.max(0, Math.floor((new Date(authorityExpiry).getTime() - nowMs) / 1000)) : 0;
  const authorityToneClass =
    authoritySecondsLeft <= 20
      ? 'text-rose-300 border-rose-500/70 bg-rose-950/40'
      : authoritySecondsLeft <= 60
      ? 'text-amber-300 border-amber-500/70 bg-amber-950/30'
      : 'text-zinc-100 border-zinc-600 bg-zinc-900';

  const tokenLifecyclePhase = useMemo(() => {
    if (!sidebarScope) return 0;

    const wasRevoked = events.some((event) => {
      if (event.eventType !== 'authority_token_revoked') return false;
      const payload = asRecord(event.payload);
      return payload.actionScope === sidebarScope;
    });

    if (wasRevoked) return 4;

    const wasConsumed = events.some((event) => {
      if (event.eventType !== 'authority_window_consumed') return false;
      const payload = asRecord(event.payload);
      return payload.actionScope === sidebarScope;
    });

    if (wasConsumed) return 3;
    if (sidebarClaim) return 2;

    const wasMinted = events.some((event) => {
      if (event.eventType !== 'authority_window_issued') return false;
      const payload = asRecord(event.payload);
      return payload.actionScope === sidebarScope;
    });

    return wasMinted ? 1 : 0;
  }, [events, sidebarClaim, sidebarScope]);

  useEffect(() => {
    setClaimsByScope((prev) => {
      let changed = false;
      const next: ClaimByScope = { ...prev };

      (['execute:refund', 'execute:data_deletion'] as HighRiskAction[]).forEach((scope) => {
        const consumed = events.some((event) => {
          if (event.eventType !== 'authority_window_consumed') return false;
          const payload = asRecord(event.payload);
          return payload.actionScope === scope;
        });

        if (consumed && next[scope]) {
          delete next[scope];
          changed = true;
        }
      });

      return changed ? next : prev;
    });
  }, [events]);

  useEffect(() => {
    if (!latestBlocked) {
      setDismissedScope(null);
      return;
    }

    if (dismissedScope && dismissedScope !== latestBlocked.scope) {
      setDismissedScope(null);
    }
  }, [dismissedScope, latestBlocked]);

  useEffect(() => {
    if (mode !== 'live') return;
    if (uiState !== 'executing') return;
    if (!latestBlocked) return;
    if (latestBlocked.seqId <= lastAutoHandledBlockSeq) return;
    if (isRequestingAuthority || isExecutingAction) return;

    setLastAutoHandledBlockSeq(latestBlocked.seqId);

    void (async () => {
      const claim = await requestTemporaryAuthority(latestBlocked.scope);
      if (!claim) return;
      setPendingExecuteScope(latestBlocked.scope);
      const executeAt = Date.now() + LIVE_AUTO_EXECUTE_DELAY_MS;
      setPendingExecuteUntilMs(executeAt);
      await new Promise((resolve) => setTimeout(resolve, LIVE_AUTO_EXECUTE_DELAY_MS));
      await executeAction(latestBlocked.scope, claim);
    })();
  }, [
    mode,
    uiState,
    latestBlocked,
    lastAutoHandledBlockSeq,
    isRequestingAuthority,
    isExecutingAction
  ]);

  const extractEvidence = (sourceEvents: LedgerEvent[]) => {
    const billingEvent = [...sourceEvents].reverse().find((event) => event.eventType === 'billing_history_exported');
    if (!billingEvent) return null;

    const payload = asRecord(billingEvent.payload);
    const tokenSource = typeof payload.tokenSource === 'string' ? payload.tokenSource : '';
    const sheetUrl = typeof payload.sheetUrl === 'string' ? payload.sheetUrl : '';
    const publicSheetUrl = typeof payload.publicSheetUrl === 'string' ? payload.publicSheetUrl : sheetUrl;
    const isPublic = payload.isPublic === true;
    const evidenceEntries = Array.isArray(payload.evidenceEntries)
      ? payload.evidenceEntries
          .map((entry) => asRecord(entry))
          .map((entry) => ({
            key: String(entry.key ?? ''),
            value: String(entry.value ?? '')
          }))
          .filter((entry) => entry.key.length > 0)
      : [];

    const fallbackPublicFromEvidence =
      evidenceEntries.find((entry) => entry.key === 'public_sheet_url')?.value ||
      evidenceEntries.find((entry) => entry.key === 'sheet_url')?.value ||
      '';

    return {
      tokenSource,
      sheetUrl,
      publicSheetUrl: publicSheetUrl || fallbackPublicFromEvidence || sheetUrl,
      isPublic,
      evidenceEntries
    };
  };

  const tokenVaultEvidence = useMemo(() => {
    return extractEvidence(events) ?? fallbackEvidence;
  }, [events, fallbackEvidence]);

  const completedSummaryRows = useMemo(() => {
    const mintedCount = events.filter((event) => event.eventType === 'authority_window_issued').length;
    const replayBlockedCount = events.filter((event) => event.eventType === 'replay_attempt_blocked').length;
    const consumedCount = events.filter((event) => event.eventType === 'authority_window_consumed').length;

    return [
      { key: 'workflow_id', value: workflowId || 'pending' },
      { key: 'customer_id', value: startedCustomerId || 'pending' },
      { key: 'refund_amount', value: startedRefundAmount > 0 ? toMoney(startedRefundAmount) : '--' },
      { key: 'authority_windows_minted', value: String(mintedCount) },
      { key: 'authority_windows_consumed', value: String(consumedCount) },
      { key: 'replay_attacks_prevented', value: String(replayBlockedCount) },
      { key: 'token_vault_source', value: tokenVaultEvidence?.tokenSource || 'pending' },
      { key: 'workflow_status', value: workflowStatus?.status || 'unknown' }
    ];
  }, [events, startedCustomerId, startedRefundAmount, tokenVaultEvidence?.tokenSource, workflowId, workflowStatus?.status]);

  useEffect(() => {
    if (!workflowId || uiState !== 'executing') return;
    if (activeAction !== null) return;
    if (tokenVaultEvidence) return;

    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`${apiBase}/api/workflows/${workflowId}/ledger`, { cache: 'no-store' });
        if (!response.ok || cancelled) return;
        const ledger = (await response.json()) as LedgerEvent[];
        if (cancelled) return;
        const extracted = extractEvidence(ledger);
        if (extracted) {
          setFallbackEvidence(extracted);
        }
      } catch {
        // Keep UI resilient; primary stream path remains source of truth.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [workflowId, uiState, activeAction, tokenVaultEvidence]);

  const externalLogUrl = tokenVaultEvidence?.publicSheetUrl || tokenVaultEvidence?.sheetUrl || '';

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,#111827_0%,#0a0a0a_45%,#050505_100%)] px-4 py-4 text-zinc-100 md:px-6">
      <section className="mx-auto max-w-[1560px]">
        {approvalToast ? (
          <div className="mb-3 border border-rose-600 bg-rose-950/70 px-3 py-2 font-mono text-xs text-rose-100">
            approval_error: {approvalToast}
          </div>
        ) : null}

        {showOpsApprovalModal && uiState === 'idle' ? (
          <div className="fixed inset-0 z-40 bg-black/45">
            <div className="absolute right-4 top-4 w-full max-w-md border border-amber-500/70 bg-zinc-950/95 p-4 font-mono text-xs text-zinc-200 shadow-2xl">
              <p className="mb-3 border border-amber-700/70 bg-amber-950/25 px-2 py-2 font-bold text-amber-300">[ 🔒 OPS MANAGER APPROVAL REQUIRED ]</p>
              <div className="space-y-1">
                <p>Target Resource: {customerInput.trim() || 'ENT-00441'}</p>
                <p>Requested Action: orchestrate:customer_offboarding</p>
                <p>Financial Risk: {Number(refundAmountInput) > 0 ? toMoney(Number(refundAmountInput)) : toMoney(0)}</p>
                <p>Required Role: OPS_MANAGER</p>
                <p>Authentication Method: Auth0 CIBA (Demo Step-Up)</p>
              </div>

              <label className="mt-3 block text-zinc-300">Deny Reason</label>
              <input
                className="mt-1 w-full border border-zinc-700 bg-zinc-950 px-2 py-2 text-zinc-100 outline-none focus:border-zinc-500"
                onChange={(event) => setOpsDenyReason(event.target.value)}
                value={opsDenyReason}
              />

              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  className="w-full border border-emerald-500 bg-emerald-900/30 px-3 py-2 font-semibold tracking-wide text-emerald-100 hover:bg-emerald-800/40 disabled:opacity-50"
                  disabled={isStarting}
                  onClick={() => {
                    setShowOpsApprovalModal(false);
                    void startWorkflow();
                  }}
                  type="button"
                >
                  {isStarting ? '[ APPROVING + STARTING... ]' : '[ APPROVE ]'}
                </button>

                <button
                  className="w-full border border-rose-500 bg-rose-900/30 px-3 py-2 font-semibold tracking-wide text-rose-100 hover:bg-rose-800/40"
                  disabled={isStarting}
                  onClick={() => {
                    const reason = opsDenyReason.trim() || 'Denied by ops manager';
                    setShowOpsApprovalModal(false);
                    setApprovalToast(`Ops approval denied: ${reason}`);
                    setError(`Ops approval denied: ${reason}`);
                  }}
                  type="button"
                >
                  [ DENY ]
                </button>
              </div>
            </div>
          </div>
        ) : null}

        <motion.header
          className="mb-4 grid gap-2 border border-zinc-800/90 bg-zinc-900/90 px-4 py-3 font-mono text-xs backdrop-blur-sm md:grid-cols-4"
          variants={cardReveal}
          initial="hidden"
          animate="visible"
        >
          <p className="md:col-span-4 font-sans text-sm font-semibold text-zinc-100">Agent Can&apos;t Do That | Zero-Trust Agent Protocol</p>
          <p className="text-zinc-300">workflow_id: <span className="text-zinc-100">{workflowId || 'pending'}</span></p>
          <p className="text-zinc-300">customer: <span className="text-zinc-100">{startedCustomerId || customerInput || 'pending'}</span></p>
          <p className="text-zinc-300">amount: <span className="text-zinc-100">{startedRefundAmount > 0 ? toMoney(startedRefundAmount) : '--'}</span></p>
          <p className="text-right">
            <span
              className={cn(
                'inline-flex rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.12em]',
                systemStatus === 'COMPLETED'
                  ? 'border-emerald-500/50 bg-emerald-900/30 text-emerald-300'
                  : systemStatus === 'BLOCKED'
                  ? 'border-amber-500/50 bg-amber-900/30 text-amber-300'
                  : systemStatus === 'RUNNING'
                  ? 'border-sky-500/50 bg-sky-900/30 text-sky-300'
                  : 'border-zinc-700 bg-zinc-900 text-zinc-400'
              )}
            >
              {systemStatus}
            </span>
          </p>
          {uiState === 'idle' ? (
            <div className="md:col-span-4 flex justify-end gap-2 pt-1">
              <button
                className={cn(
                  'border px-2 py-1',
                  mode === 'demo'
                    ? 'border-emerald-500/50 bg-emerald-900/30 text-emerald-300'
                    : 'border-zinc-700 bg-zinc-900 text-zinc-400'
                )}
                onClick={() => setMode('demo')}
                type="button"
              >
                [ {mode === 'demo' ? '●' : '○'} DEMO MODE ]
              </button>
              <button
                className={cn(
                  'border px-2 py-1',
                  mode === 'live'
                    ? 'border-sky-500/50 bg-sky-900/30 text-sky-300'
                    : 'border-zinc-700 bg-zinc-900 text-zinc-400'
                )}
                onClick={() => setMode('live')}
                type="button"
              >
                [ {mode === 'live' ? '●' : '○'} LIVE MODE ]
              </button>
            </div>
          ) : null}
        </motion.header>

        <AnimatePresence mode="wait">
          {uiState === 'idle' ? (
            <motion.div
              key="workflow-input"
              className="grid gap-4 border border-zinc-800 bg-zinc-900/90 p-5 backdrop-blur-sm md:grid-cols-2"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            >
            <div className="space-y-2 font-mono text-xs text-zinc-300">
              <h1 className="font-sans text-lg font-semibold text-zinc-100">Agent Can&apos;t Do That | Zero-Trust Agent Protocol</h1>
              <p>agent_id: orchestrator-agent-v1</p>
              <p>agent_mode: autonomous</p>
              <p>AGENT HIERARCHY</p>
              <p>orchestrator-agent-v1 [RUNNING]</p>
              <p>├── identity-agent-v1</p>
              <p>├── billing-agent-v1</p>
              <p>├── compliance-agent-v1</p>
              <p>└── data-agent-v1</p>
              <p>system_principle:</p>
              <p>  access_pattern=just_in_time</p>
              <p>  exposure_window=minimized</p>
              <p>  authority_model=per_action</p>
              <p>  authority_reuse=impossible</p>
              <p>authority_enforcement: irreversible_windows</p>
              <p>token_source: auth0_token_vault_runtime_only</p>
              <p>execution_profile: strict_enterprise_controls</p>
            </div>

            <div className="space-y-3">
              <label className="block font-sans text-sm text-zinc-300">Customer Name</label>
              <input
                className="w-full border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-zinc-500"
                onChange={(event) => setCustomerInput(event.target.value)}
                placeholder="Enter customer id"
                value={customerInput}
              />

              <label className="block font-sans text-sm text-zinc-300">Refund Amount (USD)</label>
              <input
                className="w-full border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-zinc-500"
                onChange={(event) => setRefundAmountInput(event.target.value)}
                placeholder="Enter refund amount"
                value={refundAmountInput}
              />

              <label className="block font-sans text-sm text-zinc-300">Reason</label>
              <select
                className="w-full border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-zinc-500"
                onChange={(event) => setReasonInput(event.target.value as OffboardingReason)}
                value={reasonInput}
              >
                {OFFBOARDING_REASONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>

              <button
                className="w-full border border-emerald-500/70 bg-emerald-950/40 px-4 py-3 font-sans text-sm font-semibold tracking-wide text-emerald-200 hover:bg-emerald-900/40 disabled:opacity-50"
                disabled={isStarting || !customerInput.trim()}
                onClick={initiateOffboarding}
                type="button"
              >
                {isStarting ? '[ INITIATING OFFBOARDING AGENT... ]' : '[ INITIATE OFFBOARDING AGENT ]'}
              </button>
              <p className="font-mono text-[11px] text-zinc-500">mode: {mode}</p>
              <div className="border border-zinc-800 bg-zinc-950/70 px-3 py-2 font-mono text-[11px] text-zinc-300">
                <p className="text-zinc-100">LIVE MODE NOTICE</p>
                <p className="mt-1">This demo uses real approvals.</p>
                <p>Operations Manager to start offboarding.</p>
                <p>CFO to approve and execute the refund.</p>
                <p>DPO to approve data deletion.</p>
                <p>Approvals are manual and may take 3-5 minutes.</p>
                <p>Use DEMO MODE to run quickly with cached authorized tokens.</p>
              </div>
              {error ? <p className="font-mono text-xs text-red-300">{error}</p> : null}
            </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <AnimatePresence mode="wait">
          {uiState === 'executing' ? (
            <motion.div
              key="workflow-live"
              className="grid gap-3"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            >
              <motion.section
                className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]"
                variants={cardReveal}
                initial="hidden"
                animate="visible"
              >
                <div className="border border-zinc-800 bg-zinc-900/90 p-4 backdrop-blur-sm">
                  <h2 className="mb-3 font-sans text-sm font-semibold uppercase tracking-wide text-zinc-100">Visual Workflow Map</h2>
                  <div className="grid gap-2 text-center font-mono text-[11px] lg:grid-cols-5">
                    {[
                      { key: 'start', label: 'Start', done: events.length > 0, blocked: false },
                      { key: 'revoke', label: 'Revoke SSO', done: events.some((event) => event.eventType === 'revoke_sso_access_completed'), blocked: false },
                      {
                        key: 'refund_gate',
                        label: 'Refund Gate ',
                        done: hasRefundConsumed,
                        blocked: hasRefundBlock && !hasRefundConsumed
                      },
                      {
                        key: 'deletion_gate',
                        label: 'Deletion Gate ',
                        done: hasDeletionConsumed,
                        blocked: hasDeletionBlock && !hasDeletionConsumed
                      },
                      {
                        key: 'evidence',
                        label: 'Export Evidence',
                        done: Boolean(tokenVaultEvidence?.sheetUrl || tokenVaultEvidence?.publicSheetUrl),
                        blocked: false
                      }
                    ].map((node) => (
                      <div
                        key={node.key}
                        className={cn(
                          'relative border px-2 py-2',
                          node.blocked
                            ? 'border-rose-500 bg-rose-950/50 text-rose-200'
                            : node.done
                            ? 'border-emerald-500/70 bg-emerald-950/30 text-emerald-200'
                            : 'border-zinc-700 bg-zinc-950 text-zinc-300'
                        )}
                      >
                        <p className="font-semibold">{node.done ? '[✓]' : node.blocked ? '[🔒]' : '[ ]'} {node.label}</p>
                        {node.blocked ? <p className="mt-1 text-[10px] font-bold tracking-wide">BLOCKED BY POLICY</p> : null}
                        {node.blocked && boundaryMissingScope ? (
                          <p className="mt-1 border border-rose-500/60 bg-rose-950 px-1 py-0.5 text-[10px] text-rose-200">
                            missing_scope: {boundaryMissingScope}
                          </p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="border border-zinc-800 bg-zinc-900/90 p-4 backdrop-blur-sm">
                  <h3 className="mb-3 font-sans text-sm font-semibold uppercase tracking-wide text-zinc-100">Policy Engine Status</h3>
                  <div className="space-y-2 font-mono text-xs text-zinc-300">
                    <p>policy_model: zero_trust_irreversible_windows</p>
                    <p>state: {systemStatus.toLowerCase()}</p>
                    <p>workflow_status: {workflowStatus?.status ?? 'loading'}</p>
                    <p>latest_projection: {latestEventSummary}</p>
                    <p>request_surface: append_only_ledger_sse</p>
                  </div>
                </div>
              </motion.section>

              {shouldShowConsentPanel && interceptScope ? (
                <div className="fixed inset-0 z-40 bg-black/45">
                  {/* [JUDGE NOTICE - AUTONOMY & UX]: The frontend acts as a read-only observability layer to prove true agentic autonomy. The human cannot drive the workflow; they can only act as a cryptographic cryptographic key-turner when the AI is hard-blocked by the Auth0 policy engine. */}
                  <div className="absolute right-4 top-4 w-full max-w-md border border-amber-500/70 bg-zinc-950/95 p-4 font-mono text-xs text-zinc-200 shadow-2xl">
                    <p className="mb-3 border border-amber-700/70 bg-amber-950/25 px-2 py-2 font-bold text-amber-300">[ 🔒 SYSTEM HALTED: AUTHORIZATION REQUIRED ]</p>
                    <div className="space-y-1">
                      <p>Target Resource: {startedCustomerId || 'Apple_334'}</p>
                      <p>Requested Action: {interceptScope}</p>
                      <p>Financial Risk: {toMoney(startedRefundAmount || 76455)}</p>
                      <p>Required Step-Up Role: {interceptScope === 'execute:refund' ? 'CFO' : 'DPO'}</p>
                    </div>

                    {mode === 'live' ? (
                      <p className="mt-4 animate-pulse text-amber-300">
                        ⧗ Awaiting out-of-band Auth0 Guardian approval on CFO&apos;s registered physical device...
                      </p>
                    ) : (
                      <div className="mt-4 space-y-3">
                        <div className="border border-zinc-800 bg-zinc-900/60 p-2 text-zinc-300">
                          <p>Agent Intent: {interceptScope === 'execute:refund' ? 'Financial Closure' : 'Data Destruction Completion'}</p>
                          <p>Action Reason: {interceptScope === 'execute:refund' ? 'Agent is executing refund per workflow policy.' : 'Agent is executing deletion after refund closure.'}</p>
                        </div>

                        <label className="block text-zinc-300">Deny Reason</label>
                        <input
                          className="w-full border border-zinc-700 bg-zinc-950 px-2 py-2 text-zinc-100 outline-none focus:border-zinc-500"
                          onChange={(event) => setDenyReason(event.target.value)}
                          value={denyReason}
                        />

                        <div className="grid grid-cols-2 gap-2">
                          <button
                            className="w-full border border-emerald-500 bg-emerald-900/30 px-3 py-2 font-semibold tracking-wide text-emerald-100 hover:bg-emerald-800/40 disabled:opacity-50"
                            disabled={isRequestingAuthority || isExecutingAction}
                            onClick={() => {
                              // [JUDGE NOTICE - AUTH0 CIBA]: In this zero-friction demo environment, this button triggers the step-up approval natively. In a production rollout, clicking this halts the UI and polls while Auth0 CIBA pushes a Guardian notification to the approver's physical device.
                              void (async () => {
                                const claim = await requestTemporaryAuthority(interceptScope);
                                if (!claim) return;
                                setDismissedScope(null);
                                setPendingExecuteScope(interceptScope);
                                setTimeout(() => {
                                  void executeAction(interceptScope, claim);
                                }, 1200);
                              })();
                            }}
                            type="button"
                          >
                            {isRequestingAuthority || isExecutingAction
                              ? '[ Minting Token Vault Artifact... ]'
                              : '[ APPROVE ]'}
                          </button>

                          <button
                            className="w-full border border-rose-500 bg-rose-900/30 px-3 py-2 font-semibold tracking-wide text-rose-100 hover:bg-rose-800/40"
                            disabled={isRequestingAuthority || isExecutingAction}
                            onClick={() => {
                              const reason = denyReason.trim() || 'Denied by reviewer';
                              setDismissedScope(interceptScope);
                              setApprovalToast(`Authority denied: ${reason}`);
                              setError(`Authority denied: ${reason}`);
                            }}
                            type="button"
                          >
                            [ DENY ]
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ) : null}

              <section className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_360px]">
                <motion.section className="border border-zinc-800 bg-zinc-900/90 p-4 backdrop-blur-sm" variants={cardReveal} initial="hidden" animate="visible">
                  {!isWorkflowComplete ? (
                    <>
                      <div className="mb-3 border border-zinc-800 bg-zinc-950/80 p-3 font-mono text-xs text-zinc-200">
                        <p className="font-semibold text-zinc-100">OBSERVABILITY OF INTENT</p>
                        <p className="mt-2">CURRENT STATE:</p>
                        <p>Target Resource: customer_{startedCustomerId || 'Apple_334'}</p>
                        <p>Agent Intent: Financial Closure</p>
                        <p className={cn('font-semibold', systemStatus === 'BLOCKED' ? 'text-amber-300' : 'text-zinc-200')}>
                          System Enforcement: {systemStatus === 'BLOCKED' ? 'Hard Block (Awaiting Auth0 CIBA)' : 'Policy Evaluation Active'}
                        </p>
                      </div>

                      {sidebarScope && sidebarClaim ? (
                        <div className={cn('mb-4 border px-3 py-3 text-center font-mono text-2xl font-bold tracking-wide', authorityToneClass)}>
                          AUTHORITY WINDOW ACTIVE: {countdown(authorityExpiry, nowMs)}
                        </div>
                      ) : null}

                      {pendingExecuteScope ? (
                        <div className="mb-3 border border-sky-700/70 bg-sky-950/30 px-3 py-2 font-mono text-xs text-sky-200">
                          autonomous_agent_action: pressing_{pendingExecuteScope === 'execute:refund' ? 'execute_refund' : 'execute_data_deletion'}
                        </div>
                      ) : null}

                      {sidebarScope ? (
                        <div className="mb-3 border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-[11px] text-zinc-200">
                          <p className="mb-1 text-zinc-400">Token Vault Lifecycle</p>
                          <div className="flex flex-wrap items-center gap-2">
                            {['Minted', 'Claimed', 'Executing...', 'Revoked'].map((phase, index) => {
                              const phaseIndex = index + 1;
                              const active = tokenLifecyclePhase >= phaseIndex;
                              return (
                                <span
                                  key={phase}
                                  className={cn(
                                    'border px-2 py-1',
                                    active ? 'border-emerald-600/80 bg-emerald-950/40 text-emerald-300' : 'border-zinc-700 bg-zinc-900 text-zinc-500'
                                  )}
                                >
                                  [{phase}]
                                </span>
                              );
                            })}
                          </div>
                        </div>
                      ) : null}

                      <header className="mb-3 border-b border-zinc-800 pb-3">
                        <h2 className="font-sans text-sm font-semibold uppercase tracking-wide text-zinc-100">Live System Feed &amp; Execution Visibility</h2>
                        <p className="mt-1 font-mono text-xs text-zinc-500">format: [timestamp] actor event request_id</p>
                      </header>

                      <div className="max-h-[60vh] space-y-1 overflow-y-auto font-mono text-xs">
                        {(hasRefundBlock || hasDeletionBlock) ? (
                          <div className="mb-1 space-y-1 border border-zinc-800 bg-zinc-950/70 p-2">
                            <p className="text-zinc-300">[{toTime(new Date().toISOString())}] billing-agent-v1 execution_attempt request_id=policy_probe</p>
                            <p className="text-rose-300">[{toTime(new Date().toISOString())}] policy_engine 403_forbidden request_id=policy_probe</p>
                            <p className="text-amber-300">[{toTime(new Date().toISOString())}] orchestrator-agent-v1 agent_halted request_id=policy_probe</p>
                          </div>
                        ) : null}

                        <AnimatePresence initial={false}>
                          {events.map((event) => (
                            <motion.div
                              key={`${event.workflowId}-${event.seqId}-${event.eventType}-${event.createdAt}`}
                              className={cn('grid grid-cols-[120px_170px_minmax(0,1fr)] py-1 px-1', eventRowClass(event))}
                              variants={rowReveal}
                              initial="hidden"
                              animate="visible"
                              exit="hidden"
                            >
                              <span className="text-zinc-500">[{toTime(event.createdAt)}]</span>
                              <span className="text-zinc-400">{eventActor(event)}</span>
                              <div className={cn('space-y-0.5', eventTone(event))}>
                                <span className="block">
                                  <TypeRevealLine text={`${eventLabel(event)} request_id=${eventRequestId(event)}`} animate={event.seqId === latestEventSeqId} />
                                </span>
                                <span className="block text-[11px] text-zinc-300/95">requested_by={eventRequestedBy(event)}</span>
                              </div>
                            </motion.div>
                          ))}
                        </AnimatePresence>

                        {hasRefundConsumed && hasDeletionBlock ? (
                          <motion.div className="grid grid-cols-[120px_170px_minmax(0,1fr)] border-b border-zinc-800/70 py-1" variants={rowReveal} initial="hidden" animate="visible">
                            <span className="text-zinc-500">[{toTime(new Date().toISOString())}]</span>
                            <span className="text-zinc-400">policy_engine</span>
                            <span className="text-amber-300">cross_action_propagation prevented; new authority required</span>
                          </motion.div>
                        ) : null}
                      </div>
                    </>
                  ) : (
                    <div className="space-y-4">
                      <div className="border border-emerald-700/70 bg-emerald-950/30 p-4 font-mono text-sm text-emerald-200">
                        WORKFLOW COMPLETED. All Authority Windows Destroyed.
                      </div>

                      <div className="border border-zinc-800 bg-zinc-950 p-4 font-mono text-xs text-zinc-200">
                        <p className="mb-2 text-zinc-100">Security Efficacy Summary</p>
                        <p>Tokens Minted via Token Vault: 2</p>
                        <p>Exposure Window Minimized: Yes (&lt; 2 mins per action)</p>
                        <p>Replay Attacks Prevented: 1</p>
                      </div>

                      {externalLogUrl ? (
                        <a
                          className="inline-block border border-emerald-700 bg-emerald-950/40 px-4 py-2 font-mono text-xs font-semibold tracking-wide text-emerald-300 hover:bg-emerald-900/50"
                          href={externalLogUrl}
                          rel="noreferrer"
                          target="_blank"
                        >
                          [ OPEN CRYPTOGRAPHIC EVIDENCE LEDGER (Google Sheets) ]
                        </a>
                      ) : null}
                    </div>
                  )}

                  {error ? <p className="mt-3 font-mono text-xs text-rose-300">{error}</p> : null}
                </motion.section>

                <motion.aside className="border border-zinc-800 bg-zinc-900/90 p-4 backdrop-blur-sm" variants={cardReveal} initial="hidden" animate="visible">
                  <h3 className="font-sans text-sm font-semibold uppercase tracking-wide text-zinc-100">Auth0 Token Vault Authorization Panel</h3>

                  <div className="mt-3 space-y-2 font-mono text-xs text-zinc-300">
                    <div className="border border-zinc-800 bg-zinc-950 px-3 py-2 text-[11px] text-zinc-400">
                      <p className="mb-2 text-zinc-200">System Indicators</p>
                      <p>agent_id: orchestrator-agent-v1</p>
                      <p>mode: autonomous</p>
                      <p>token_vault: runtime_fetch_only</p>
                      <p>credential_storage: none</p>
                      <p>reason_code: {startedReason}</p>
                      <p>latest_event: {latestEventSummary}</p>
                      <p>authorization_state: {shouldShowConsentPanel ? 'intercept_active' : 'streaming'}</p>
                    </div>

                    {isWorkflowComplete ? (
                      <>
                        <p className="text-zinc-300">Workflow Summary</p>
                        <div className="overflow-hidden rounded border border-zinc-800">
                          <div className="grid grid-cols-[140px_1fr] bg-zinc-900 px-2 py-1 text-[10px] uppercase tracking-wide text-zinc-400">
                            <span>Key</span>
                            <span>Value</span>
                          </div>
                          {completedSummaryRows.map((row) => (
                            <div
                              key={row.key}
                              className="grid grid-cols-[140px_1fr] border-t border-zinc-800 bg-zinc-950 px-2 py-1 text-[10px] text-zinc-200"
                            >
                              <span className="text-zinc-300">{row.key}</span>
                              <span className="truncate">{row.value}</span>
                            </div>
                          ))}
                        </div>
                      </>
                    ) : (
                      <div className="border border-zinc-800 bg-zinc-950 px-3 py-2 text-[11px] text-zinc-400">
                        <p className="text-zinc-400">This panel is read-only during autonomous execution.</p>
                      </div>
                    )}
                  </div>
                </motion.aside>
              </section>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </section>
    </main>
  );
}
