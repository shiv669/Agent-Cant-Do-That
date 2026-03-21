'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { LedgerEvent, StartOffboardingResponse, WorkflowStatusResponse } from '@contracts/index';

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

export default function HomePage() {
  const [customerId, setCustomerId] = useState('ENT-00441');
  const [isLoading, setIsLoading] = useState(false);
  const [startResult, setStartResult] = useState<StartOffboardingResponse | null>(null);
  const [status, setStatus] = useState<WorkflowStatusResponse | null>(null);
  const [ledger, setLedger] = useState<LedgerEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const workflowId = useMemo(() => startResult?.workflowId ?? '', [startResult]);

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

      const ledgerResponse = await fetch(`${apiBase}/api/workflows/${data.workflowId}/ledger`);
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

    const ledgerResponse = await fetch(`${apiBase}/api/workflows/${workflowId}/ledger`);
    if (ledgerResponse.ok) {
      setLedger((await ledgerResponse.json()) as LedgerEvent[]);
    }
  };

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
