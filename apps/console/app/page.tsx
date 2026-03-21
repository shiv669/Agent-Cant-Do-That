import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="min-h-screen bg-background px-6 py-10">
      <div className="mx-auto max-w-3xl space-y-6">
        <h1 className="text-3xl font-semibold text-primary">Agent Can&apos;t Do That</h1>
        <p className="text-base text-slate-700">
          Console scaffold is ready. Open the hero design preview route to validate visual integration.
        </p>
        <Link className="inline-block rounded border border-primary px-4 py-2 text-primary" href="/demo">
          Open Demo Screen
        </Link>
      </div>
    </main>
  );
}
