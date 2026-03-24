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

type UIState = 'idle' | 'executing' | 'complete';
type HighRiskAction = 'execute:refund' | 'execute:data_deletion';

type WindowInfo = {
  windowId: string;
  actionScope: HighRiskAction;
  expiresAt?: string;
};

type ClaimByScope = Partial<Record<HighRiskAction, AuthorityWindowClaimResponse>>;

type OffboardingReason = 'contract_termination' | 'fraud_review' | 'compliance_exit' | 'customer_request';
type EventMessage = {
  base: string;
  actionReason?: string;
  reasoning?: string;
};

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
  const message = eventMessage(event);

  if (!message.actionReason && !message.reasoning) {
    return message.base;
  }

  if (message.actionReason && message.reasoning) {
    return `${message.base} | reason=${message.actionReason} | rationale=${message.reasoning}`;
  }

  return `${message.base} | reason=${message.actionReason || message.reasoning}`;
}

function eventMessage(event: LedgerEvent): EventMessage {
  const payload = asRecord(event.payload);
  const actionReason = typeof payload.actionReason === 'string' ? payload.actionReason : '';
  const reasoning = typeof payload.reasoning === 'string' ? payload.reasoning : '';

  if (event.eventType === 'step_up_requested') {
    const scope = String(payload.actionScope ?? 'unknown');
    const approver = String(payload.approverRole ?? 'approver');
    return {
      base: `step_up requested action=${scope} approver=${approver}`,
      actionReason,
      reasoning
    };
  }

  if (event.eventType === 'step_up_approved') {
    const scope = String(payload.actionScope ?? 'unknown');
    return {
      base: `step_up approved action=${scope}`,
      actionReason,
      reasoning
    };
  }

  if (event.eventType === 'high_risk_action_blocked') {
    const scope = String(payload.actionScope ?? '');
    if (scope === 'execute:refund') {
      return {
        base: 'system.response 403 forbidden missing_scope=execute:refund',
        actionReason,
        reasoning
      };
    }
    if (scope === 'execute:data_deletion') {
      return {
        base: 'system.response 403 forbidden missing_scope=execute:data_deletion',
        actionReason,
        reasoning
      };
    }
  }

  if (event.eventType === 'authority_window_consumed') {
    const scope = String(payload.actionScope ?? '');
    if (scope === 'execute:refund') return { base: 'agent.execute(refund) system.result success', actionReason, reasoning };
    if (scope === 'execute:data_deletion')
      return { base: 'agent.execute(data_deletion) system.result success', actionReason, reasoning };
  }

  if (event.eventType === 'authority_window_requested') {
    const scope = String(payload.actionScope ?? 'unknown');
    const ttl = payload.ttlSeconds;
    return {
      base: `authority.window requested action=${scope} ttl=${String(ttl ?? 'n/a')}`,
      actionReason,
      reasoning
    };
  }

  if (event.eventType === 'authority_window_issued') {
    return {
      base: `authority.window issued action=${String(payload.actionScope ?? 'unknown')}`,
      actionReason,
      reasoning
    };
  }

  if (event.eventType === 'authority_token_revoked') {
    return { base: 'authority.token revoked', actionReason, reasoning };
  }

  if (event.eventType === 'billing_history_exported') {
    const tokenSource = typeof payload.tokenSource === 'string' ? payload.tokenSource : 'none';
    const exportFormat = typeof payload.exportFormat === 'string' ? payload.exportFormat : 'unknown';
    const url = typeof payload.sheetUrl === 'string' ? payload.sheetUrl : '';
    const suffix = url ? ` sheet_url=${url}` : '';
    return {
      base: `billing export=${exportFormat} token_source=${tokenSource}${suffix}`,
      actionReason,
      reasoning
    };
  }

  if (event.eventType === 'unauthorized_escalation_attempt_recorded') {
    return { base: 'escalation_attempt_recorded', actionReason, reasoning };
  }

  return { base: event.eventType, actionReason, reasoning };
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
  const [customerInput, setCustomerInput] = useState('');
  const [refundAmountInput, setRefundAmountInput] = useState('');
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
        if (prev.some((event) => event.seqId === incoming.seqId)) {
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
          'x-agent-client-id': 'orchestrator-a'
        },
        body: JSON.stringify({ customerId: normalizedCustomer, refundAmountUsd: parsedRefundAmount })
      });

      if (!response.ok) {
        throw new Error(`Failed to start workflow (${response.status})`);
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
          customerId: startedCustomerId,
          actionScope: scope,
          boundAgentClientId: 'subagent-d-only',
          amount: scope === 'execute:refund' ? startedRefundAmount : undefined,
          ttlSeconds: 120,
          actionReason: `Operator requested temporary authority for ${prettyScope(scope)}`,
          reasoning: `Step-up approval requested for ${startedCustomerId} in workflow ${workflowId}`
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
          windowId: claim.windowId,
          actionReason: `Operator executed ${prettyScope(scope)} after approval`,
          reasoning: `Single-use authority window consumed for ${prettyScope(scope)} in workflow ${workflowId}`
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Execution failed');
    } finally {
      setIsExecutingAction(false);
    }
  };

  const forceExecute = async (scope: HighRiskAction) => {
    if (!workflowId) return;

    setError(null);

    try {
      await fetch(`${apiBase}/api/authority/high-risk/check`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-agent-client-id': 'subagent-d-only'
        },
        body: JSON.stringify({
          workflowId,
          actionScope: scope,
          actionReason: 'Operator forced execution without authority',
          reasoning: 'Requested force execution for boundary validation'
        })
      });
    } catch {
      // Force execute is expected to be denied and logged by policy engine.
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

  const tokenVaultEvidence = useMemo(() => {
    const billingEvent = [...events].reverse().find((event) => event.eventType === 'billing_history_exported');
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

    if (!tokenSource.toLowerCase().includes('token vault')) {
      return null;
    }

    return {
      tokenSource,
      sheetUrl,
      publicSheetUrl,
      isPublic,
      evidenceEntries
    };
  }, [events]);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,#111827_0%,#0a0a0a_45%,#050505_100%)] px-4 py-4 text-zinc-100 md:px-6">
      <section className="mx-auto max-w-[1560px]">
        <motion.header
          className="mb-4 grid gap-2 border border-zinc-800/90 bg-zinc-900/90 px-4 py-3 font-mono text-xs backdrop-blur-sm md:grid-cols-4"
          variants={cardReveal}
          initial="hidden"
          animate="visible"
        >
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
              <h1 className="font-sans text-lg font-semibold text-zinc-100">Internal Offboarding Console</h1>
              <p>agent_id: orchestrator-agent-v1</p>
              <p>agent_mode: autonomous</p>
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
                className="border border-zinc-600 bg-zinc-800 px-4 py-2 font-sans text-sm hover:bg-zinc-700 disabled:opacity-50"
                disabled={isStarting || !customerInput.trim()}
                onClick={() => {
                  void startWorkflow();
                }}
                type="button"
              >
                {isStarting ? 'STARTING WORKFLOW...' : 'START WORKFLOW'}
              </button>
              {error ? <p className="font-mono text-xs text-red-300">{error}</p> : null}
            </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <AnimatePresence mode="wait">
          {uiState === 'executing' ? (
            <motion.div
              key="workflow-live"
              className="grid gap-3 xl:grid-cols-[310px_minmax(0,1fr)_340px]"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            >
            <motion.aside className="border border-zinc-800 bg-zinc-900/90 p-4 backdrop-blur-sm" variants={cardReveal} initial="hidden" animate="visible">
              <h2 className="mb-3 font-sans text-sm font-semibold uppercase tracking-wide text-zinc-100">Workflow / Agent State</h2>
              <div className="space-y-2 font-mono text-xs text-zinc-300">
                <p>agent_id: orchestrator-agent-v1</p>
                <p>mode: autonomous</p>
                <p>state: {systemStatus.toLowerCase()}</p>
                <p>workflow_status: {workflowStatus?.status ?? 'loading'}</p>
                <p>customer_id: {startedCustomerId}</p>
                <p>refund_amount: {toMoney(startedRefundAmount)}</p>
                <p>reason_code: {startedReason}</p>
                <p>agent_now: {latestEventSummary}</p>
                <p>token_vault: runtime_fetch_only</p>
                <p>credential_storage: none</p>
              </div>
            </motion.aside>

            <motion.section className="border border-zinc-800 bg-zinc-900/90 p-4 backdrop-blur-sm" variants={cardReveal} initial="hidden" animate="visible">
              <header className="mb-3 border-b border-zinc-800 pb-3">
                <h2 className="font-sans text-sm font-semibold uppercase tracking-wide text-zinc-100">Live Event Feed</h2>
                <p className="mt-1 font-mono text-xs text-zinc-500">backend_event_stream_only=true</p>
              </header>

              <div className="max-h-[70vh] space-y-1 overflow-y-auto font-mono text-xs">
                <AnimatePresence initial={false}>
                {events.map((event) => (
                  <motion.div
                    key={`${event.workflowId}-${event.seqId}`}
                    className="grid grid-cols-[120px_170px_minmax(0,1fr)] border-b border-zinc-800/70 py-1"
                    variants={rowReveal}
                    initial="hidden"
                    animate="visible"
                    exit="hidden"
                  >
                    <span className="text-zinc-500">[{toTime(event.createdAt)}]</span>
                    <span className="text-zinc-400">{eventActor(event)}</span>
                    <div className={cn('space-y-0.5', eventTone(event))}>
                      <span className="block">{eventMessage(event).base}</span>
                      {eventMessage(event).actionReason ? (
                        <span className="block text-[11px] text-zinc-300/95">
                          reason=<TypeRevealLine text={eventMessage(event).actionReason as string} animate={event.seqId === latestEventSeqId} />
                        </span>
                      ) : null}
                      {eventMessage(event).reasoning ? (
                        <span className="block text-[11px] text-zinc-400/90">
                          rationale=<TypeRevealLine text={eventMessage(event).reasoning as string} animate={event.seqId === latestEventSeqId} />
                        </span>
                      ) : null}
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

              {error ? <p className="mt-3 font-mono text-xs text-red-300">{error}</p> : null}
            </motion.section>

            <motion.aside className="border border-zinc-800 bg-zinc-900/90 p-4 backdrop-blur-sm" variants={cardReveal} initial="hidden" animate="visible">
              <h3 className="font-sans text-sm font-semibold uppercase tracking-wide text-zinc-100">Authority Panel</h3>

              {sidebarScope ? (
                <div className="mt-3 space-y-2 font-mono text-xs text-zinc-300">
                  <p>action: {prettyScope(sidebarScope)}</p>
                  <p>amount: {sidebarScope === 'execute:refund' ? toMoney(startedRefundAmount) : 'n/a'}</p>
                  <p>approver: {sidebarScope === 'execute:refund' ? 'CFO' : 'DPO'}</p>
                  <p>window_id: {sidebarClaim?.windowId ?? sidebarWindow?.windowId ?? 'pending'}</p>
                  <p>ttl: {countdown(sidebarClaim?.expiresAt ?? sidebarWindow?.expiresAt, nowMs)}</p>
                  <p>status: {isAwaitingApproval ? 'awaiting_approval' : sidebarClaim ? 'approved' : 'blocked'}</p>

                  {!sidebarClaim ? (
                    <div className="flex gap-2 pt-1">
                      <button
                        className="border border-zinc-600 bg-zinc-800 px-3 py-2 font-sans text-xs hover:bg-zinc-700 disabled:opacity-50"
                        disabled={
                          isRequestingAuthority ||
                          isExecutingAction ||
                          (!hasRefundBlock && sidebarScope === 'execute:refund') ||
                          (!hasDeletionBlock && sidebarScope === 'execute:data_deletion')
                        }
                        onClick={() => {
                          void requestTemporaryAuthority(sidebarScope);
                        }}
                        type="button"
                      >
                        {isRequestingAuthority ? 'requesting_authority...' : 'request_authority'}
                      </button>
                      <button
                        className="border border-zinc-700 bg-zinc-900 px-3 py-2 font-sans text-xs text-zinc-300 hover:bg-zinc-800"
                        onClick={() => {
                          void forceExecute(sidebarScope);
                        }}
                        type="button"
                      >
                        force_execute
                      </button>
                    </div>
                  ) : (
                    <button
                      className="mt-2 border border-zinc-600 bg-zinc-800 px-3 py-2 font-sans text-xs hover:bg-zinc-700 disabled:opacity-50"
                      disabled={isExecutingAction}
                      onClick={() => {
                        void executeAction(sidebarScope);
                      }}
                      type="button"
                    >
                      {isExecutingAction ? 'executing...' : sidebarScope === 'execute:refund' ? 'execute_refund' : 'execute_data_deletion'}
                    </button>
                  )}

                  <div className="mt-4 border border-zinc-800 bg-zinc-950 px-3 py-2 text-[11px] text-zinc-400">
                    {tokenVaultEvidence ? (
                      <div className="space-y-2 text-zinc-200">
                        <div className="flex items-center gap-2">
                          <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
                          <span className="font-semibold text-emerald-300">Token Vault Verified</span>
                        </div>
                        <p className="text-zinc-300">Sharing: {tokenVaultEvidence.isPublic ? 'Public (anyone with link)' : 'Restricted by provider scope'}</p>
                        {tokenVaultEvidence.publicSheetUrl ? (
                          <a
                            className="inline-block border border-emerald-700/70 bg-emerald-950/40 px-2 py-1 text-emerald-300 hover:bg-emerald-900/40"
                            href={tokenVaultEvidence.publicSheetUrl}
                            rel="noreferrer"
                            target="_blank"
                          >
                            Open Public Evidence Sheet
                          </a>
                        ) : null}

                        {tokenVaultEvidence.evidenceEntries.length > 0 ? (
                          <div className="overflow-hidden rounded border border-zinc-800">
                            <div className="grid grid-cols-[120px_1fr] bg-zinc-900 px-2 py-1 text-[10px] uppercase tracking-wide text-zinc-400">
                              <span>Evidence Key</span>
                              <span>Evidence Value</span>
                            </div>
                            {tokenVaultEvidence.evidenceEntries.map((entry, index) => (
                              <div
                                key={`${entry.key}-${index}`}
                                className="grid grid-cols-[120px_1fr] border-t border-zinc-800 bg-zinc-950 px-2 py-1 text-[10px] text-zinc-200"
                              >
                                <span className="text-zinc-300">{entry.key}</span>
                                <span className="truncate">{entry.value}</span>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <p className="text-zinc-400">Token Vault evidence will appear after billing export.</p>
                    )}
                  </div>
                </div>
              ) : (
                <div className="mt-3 space-y-2 font-mono text-xs text-zinc-300">
                  <p className="text-zinc-400">authority lifecycle complete</p>
                  {tokenVaultEvidence?.evidenceEntries.length ? (
                    <div className="overflow-hidden rounded border border-zinc-800">
                      <div className="grid grid-cols-[120px_1fr] bg-zinc-900 px-2 py-1 text-[10px] uppercase tracking-wide text-zinc-400">
                        <span>Evidence Key</span>
                        <span>Evidence Value</span>
                      </div>
                      {tokenVaultEvidence.evidenceEntries.map((entry, index) => (
                        <div
                          key={`final-${entry.key}-${index}`}
                          className="grid grid-cols-[120px_1fr] border-t border-zinc-800 bg-zinc-950 px-2 py-1 text-[10px] text-zinc-200"
                        >
                          <span className="text-zinc-300">{entry.key}</span>
                          <span className="truncate">{entry.value}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-zinc-500">No sheet rows available yet.</p>
                  )}
                </div>
              )}
            </motion.aside>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </section>
    </main>
  );
}
