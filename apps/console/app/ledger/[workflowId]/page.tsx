'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import type { LedgerEvent } from '@contracts/index';

const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4001';

type WindowState = {
  windowId: string;
  status: 'requested' | 'claimed' | 'consumed' | 'revoked' | 'expired';
  expiresAt?: string;
};

type PayloadMap = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asPayload(payload: unknown): PayloadMap {
  return isRecord(payload) ? payload : {};
}

function toMillis(value?: string): number {
  if (!value) return Number.NaN;
  return new Date(value).getTime();
}

function summarizeEvent(event: LedgerEvent): string {
  const payload = asPayload(event.payload);

  const keysByType: Record<string, string[]> = {
    revoke_sso_access_completed: ['provider'],
    billing_history_exported: ['exportFormat'],
    subscriptions_cancelled: ['cancelledCount'],
    customer_validation_passed: ['customerId', 'status'],
    data_stores_enumerated: ['storeCount'],
    compliance_check_passed: ['legalHolds', 'offboardingPermitted'],
    high_risk_action_blocked: ['actionScope', 'reason'],
    unauthorized_escalation_attempt_recorded: ['actionScope', 'reason'],
    step_up_requested: ['approverRole', 'approverUserId', 'bindingMessage'],
    step_up_approved: ['approverRole', 'approverIdentity'],
    step_up_denied: ['reason'],
    step_up_timeout: ['reason'],
    authority_window_requested: ['windowId', 'actionScope', 'expiresAt'],
    authority_window_claimed: ['windowId', 'claimantAgentClientId'],
    authority_window_issued: ['windowId', 'boundAgentClientId'],
    authority_window_consumed: ['windowId', 'claimantAgentClientId'],
    authority_token_revoked: ['windowId', 'revokedAt'],
    replay_attempt_blocked: ['windowId', 'status'],
    cross_action_propagation_check_passed: ['previousWindowId', 'newWindowRequired', 'authorityCarriedForward']
  };

  const selectedKeys = keysByType[event.eventType] ?? Object.keys(payload).slice(0, 3);
  const parts = selectedKeys
    .filter((key) => payload[key] !== undefined)
    .map((key) => `${key}=${String(payload[key])}`);

  return parts.length > 0 ? parts.join(' | ') : 'No summary fields';
}

function eventRowStyle(event: LedgerEvent, now: number, windowsById: Map<string, WindowState>): string {
  const base = 'border border-slate-800 bg-slate-950 text-slate-100';

  if (event.eventType === 'unauthorized_escalation_attempt_recorded' || event.eventType === 'replay_attempt_blocked') {
    return 'border border-red-800 bg-red-950/60 text-red-100';
  }

  if (event.eventType === 'step_up_approved' || event.eventType === 'authority_window_consumed') {
    return 'border border-emerald-800 bg-emerald-950/50 text-emerald-100';
  }

  if (event.eventType === 'authority_token_revoked') {
    return 'border border-amber-800 bg-amber-950/50 text-amber-100';
  }

  if (event.eventType === 'authority_window_requested') {
    const payload = asPayload(event.payload);
    const windowId = typeof payload.windowId === 'string' ? payload.windowId : '';
    const entry = windowId ? windowsById.get(windowId) : undefined;
    const expiryMs = toMillis(entry?.expiresAt);
    if ((entry?.status === 'requested' || entry?.status === 'claimed') && Number.isFinite(expiryMs) && expiryMs <= now) {
      return 'border border-orange-800 bg-orange-950/40 text-orange-100';
    }
  }

  return base;
}

function deriveWindowStates(events: LedgerEvent[], now: number): Map<string, WindowState> {
  const states = new Map<string, WindowState>();

  for (const event of events) {
    const payload = asPayload(event.payload);
    const windowId = typeof payload.windowId === 'string' ? payload.windowId : '';
    if (!windowId) continue;

    const existing = states.get(windowId) ?? {
      windowId,
      status: 'requested' as const,
      expiresAt: typeof payload.expiresAt === 'string' ? payload.expiresAt : undefined
    };

    if (typeof payload.expiresAt === 'string') {
      existing.expiresAt = payload.expiresAt;
    }

    if (event.eventType === 'authority_window_requested') {
      existing.status = 'requested';
    }

    if (event.eventType === 'authority_window_claimed') {
      existing.status = 'claimed';
    }

    if (event.eventType === 'authority_window_consumed') {
      existing.status = 'consumed';
    }

    if (event.eventType === 'authority_token_revoked') {
      existing.status = 'revoked';
    }

    if (event.eventType === 'replay_attempt_blocked') {
      const statusFromPayload = typeof payload.status === 'string' ? payload.status : '';
      if (statusFromPayload === 'expired') {
        existing.status = 'expired';
      }
    }

    states.set(windowId, existing);
  }

  for (const entry of states.values()) {
    const expiryMs = toMillis(entry.expiresAt);
    if ((entry.status === 'requested' || entry.status === 'claimed') && Number.isFinite(expiryMs) && expiryMs <= now) {
      entry.status = 'expired';
    }
  }

  return states;
}

function formatCountdown(msRemaining: number): string {
  if (msRemaining <= 0) return '00:00';
  const totalSeconds = Math.floor(msRemaining / 1000);
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

export default function LedgerPage() {
  const params = useParams<{ workflowId: string }>();
  const [events, setEvents] = useState<LedgerEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [clock, setClock] = useState(Date.now());
  const [newSeqIds, setNewSeqIds] = useState<Set<number>>(new Set());
  const knownSeqIdsRef = useRef<Set<number>>(new Set());

  const workflowId = decodeURIComponent(params.workflowId ?? '');

  useEffect(() => {
    const timer = setInterval(() => {
      setClock(Date.now());
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;

    const fetchLedger = async () => {
      try {
        const response = await fetch(`${apiBase}/api/authority/ledger/${workflowId}`, { cache: 'no-store' });
        if (!response.ok) {
          throw new Error(`Failed to load ledger (${response.status})`);
        }

        const incoming = (await response.json()) as LedgerEvent[];
        if (!active) return;

        const knownSeqIds = knownSeqIdsRef.current;
        const freshSeqIds: number[] = [];
        for (const item of incoming) {
          if (!knownSeqIds.has(item.seqId)) {
            freshSeqIds.push(item.seqId);
            knownSeqIds.add(item.seqId);
          }
        }

        if (freshSeqIds.length > 0) {
          setNewSeqIds(new Set(freshSeqIds));
          setTimeout(() => {
            if (!active) return;
            setNewSeqIds(new Set());
          }, 700);
        }

        setEvents(incoming);
        setError(null);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Failed to load ledger');
      }
    };

    fetchLedger();
    const interval = setInterval(fetchLedger, 3000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [workflowId]);

  const firstEventAt = events[0]?.createdAt ?? null;
  const windowsById = useMemo(() => deriveWindowStates(events, clock), [events, clock]);

  const activeWindow = useMemo(() => {
    const active = Array.from(windowsById.values()).filter((entry) => entry.status === 'requested' || entry.status === 'claimed');
    if (active.length === 0) return null;

    const sorted = active
      .map((entry) => ({ entry, expiresMs: toMillis(entry.expiresAt) }))
      .filter((item) => Number.isFinite(item.expiresMs))
      .sort((a, b) => a.expiresMs - b.expiresMs);

    if (sorted.length === 0) return null;
    return sorted[0];
  }, [windowsById]);

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-8 font-mono text-white">
      <section className="mx-auto max-w-6xl space-y-4">
        <header className="border border-slate-800 bg-slate-900 px-5 py-4">
          <h1 className="text-2xl font-bold tracking-wide">AUTHORITY LEDGER - IMMUTABLE</h1>
          <p className="mt-2 text-sm text-slate-300">
            workflowId={workflowId}
            {firstEventAt ? ` | first_event_at=${firstEventAt}` : ' | first_event_at=waiting'}
          </p>
          {activeWindow ? (
            <p className="mt-3 text-sm text-amber-300">
              Authority window expires in: {formatCountdown(activeWindow.expiresMs - clock)}
            </p>
          ) : null}
        </header>

        {error ? <div className="border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-100">{error}</div> : null}

        <div className="space-y-2">
          {events.map((event) => {
            const isNew = newSeqIds.has(event.seqId);
            const rowClass = eventRowStyle(event, clock, windowsById);
            return (
              <article
                key={`${event.workflowId}-${event.seqId}`}
                className={`${rowClass} ${isNew ? 'ledger-row-enter' : ''} grid grid-cols-[120px_280px_280px_1fr] gap-3 px-4 py-3 text-sm`}
              >
                <div className="font-semibold">SEQ {String(event.seqId).padStart(4, '0')}</div>
                <div className="text-slate-300">{event.createdAt}</div>
                <div className="font-semibold uppercase tracking-wide">{event.eventType.replaceAll('_', ' ')}</div>
                <div className="text-slate-200">{summarizeEvent(event)}</div>
              </article>
            );
          })}
        </div>

        <p className="pt-6 text-xs text-slate-500">
          All transactions executed in sandbox. No funds moved. No data deleted.
        </p>
      </section>
    </main>
  );
}
