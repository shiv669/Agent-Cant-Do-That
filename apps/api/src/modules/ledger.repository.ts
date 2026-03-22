import { Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import type { LedgerEvent } from '@contracts/index';

type LedgerInsert = {
  workflowId: string;
  eventType: LedgerEvent['eventType'];
  payload: Record<string, unknown>;
};

type LedgerRow = {
  seq_id: string;
  workflow_id: string;
  event_type: LedgerEvent['eventType'];
  event_payload: Record<string, unknown>;
  created_at: Date;
};

@Injectable()
export class LedgerRepository {
  private readonly pool: Pool;

  constructor() {
    const connectionString = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/acdt';

    this.pool = new Pool({ connectionString });
  }

  async ensureSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(`SELECT pg_advisory_lock(hashtext('authority_ledger_schema_v1'));`);

      await client.query(`
        CREATE TABLE IF NOT EXISTS authority_ledger_events (
          seq_id BIGSERIAL PRIMARY KEY,
          workflow_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          event_payload JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_authority_ledger_events_workflow_seq
        ON authority_ledger_events (workflow_id, seq_id);
      `);

      await client.query(`
        CREATE OR REPLACE FUNCTION prevent_authority_ledger_mutation()
        RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'authority_ledger_events is append-only';
        END;
        $$ LANGUAGE plpgsql;
      `);

      await client.query(`
        DROP TRIGGER IF EXISTS trg_prevent_authority_ledger_update
        ON authority_ledger_events;
      `);

      await client.query(`
        CREATE TRIGGER trg_prevent_authority_ledger_update
        BEFORE UPDATE ON authority_ledger_events
        FOR EACH ROW
        EXECUTE FUNCTION prevent_authority_ledger_mutation();
      `);

      await client.query(`
        DROP TRIGGER IF EXISTS trg_prevent_authority_ledger_delete
        ON authority_ledger_events;
      `);

      await client.query(`
        CREATE TRIGGER trg_prevent_authority_ledger_delete
        BEFORE DELETE ON authority_ledger_events
        FOR EACH ROW
        EXECUTE FUNCTION prevent_authority_ledger_mutation();
      `);
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext('authority_ledger_schema_v1'));`);
      client.release();
    }
  }

  async appendEvent(input: LedgerInsert): Promise<LedgerEvent> {
    const result = await this.pool.query<LedgerRow>(
      `
        INSERT INTO authority_ledger_events (workflow_id, event_type, event_payload)
        VALUES ($1, $2, $3::jsonb)
        RETURNING seq_id, workflow_id, event_type, event_payload, created_at;
      `,
      [input.workflowId, input.eventType, JSON.stringify(input.payload)]
    );

    return this.mapRowToEvent(result.rows[0]);
  }

  async listByWorkflowId(workflowId: string): Promise<LedgerEvent[]> {
    const result = await this.pool.query<LedgerRow>(
      `
        SELECT seq_id, workflow_id, event_type, event_payload, created_at
        FROM authority_ledger_events
        WHERE workflow_id = $1
        ORDER BY seq_id ASC;
      `,
      [workflowId]
    );

    return result.rows.map((row) => this.mapRowToEvent(row));
  }

  private mapRowToEvent(row: LedgerRow): LedgerEvent {
    return {
      seqId: Number(row.seq_id),
      workflowId: row.workflow_id,
      eventType: row.event_type,
      createdAt: new Date(row.created_at).toISOString(),
      payload: row.event_payload
    };
  }
}