'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import type { LedgerEvent, StartOffboardingResponse, WorkflowStatusResponse } from '@contracts/index';

const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4001';

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
  const [customerId, setCustomerId] = useState('ENT-00441');
  const [isLoading, setIsLoading] = useState(false);
  const [startResult, setStartResult] = useState<StartOffboardingResponse | null>(null);
  const [status, setStatus] = useState<WorkflowStatusResponse | null>(null);
  const [ledger, setLedger] = useState<LedgerEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const workflowId = useMemo(() => startResult?.workflowId ?? '', [startResult]);

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
  const blockEvent = useMemo(() => {
    return ledger.find((event) => event.eventType === 'high_risk_action_blocked');
  }, [ledger]);

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
              <strong>Status:</strong> {status?.status ?? startResult.status}
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

            {blockEvent ? (
              <div className="mt-4 bg-slate-900 px-4 py-3 font-mono text-sm text-rose-200">
                <p>████████████████████████████████</p>
                <p>AGENT CAN&apos;T DO THAT</p>
                <p>Authority window absent - execution blocked</p>
                <p>████████████████████████████████</p>
              </div>
            ) : null}
          </div>
        ) : null}

        {ledger.length > 0 ? (
          <div className="rounded border border-secondary bg-white p-4">
            <h2 className="mb-3 text-lg font-semibold text-primary">Ledger Events</h2>
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
