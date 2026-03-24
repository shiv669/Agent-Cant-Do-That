import { Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { createClient, type RedisClientType } from 'redis';
import { Observable, Subject } from 'rxjs';
import { filter } from 'rxjs/operators';
import type { LedgerEvent } from '@contracts/index';
import { EvidenceSheetService } from './evidence-sheet.service';

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
  private readonly redisUrl: string;
  private redis: RedisClientType | null = null;
  private redisConnectAttempted = false;
  private readonly ledgerCacheTtlSeconds = 30;
  private readonly eventSubject = new Subject<LedgerEvent>();

  constructor(private readonly evidenceSheetService: EvidenceSheetService) {
    const connectionString = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/acdt';
    this.redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

    this.pool = new Pool({ connectionString });
  }

  private async getRedisClient(): Promise<RedisClientType | null> {
    if (this.redisConnectAttempted && !this.redis?.isOpen) {
      return null;
    }

    if (!this.redis) {
      this.redis = createClient({ url: this.redisUrl });
      this.redis.on('error', () => {
        // Degrade gracefully to Postgres-only behavior when Redis is unavailable.
      });
    }

    if (!this.redis.isOpen) {
      this.redisConnectAttempted = true;
      try {
        await this.redis.connect();
      } catch {
        return null;
      }
    }

    return this.redis;
  }

  private ledgerCacheKey(workflowId: string): string {
    return `acdt:ledger:${workflowId}`;
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

    const event = this.mapRowToEvent(result.rows[0]);

    const redis = await this.getRedisClient();
    if (redis) {
      await redis.del(this.ledgerCacheKey(input.workflowId)).catch(() => undefined);
    }

    void this.evidenceSheetService.appendLedgerEvent(event);
    this.eventSubject.next(event);
    return event;
  }

  async listByWorkflowId(workflowId: string): Promise<LedgerEvent[]> {
    const redis = await this.getRedisClient();
    const cacheKey = this.ledgerCacheKey(workflowId);

    if (redis) {
      const cached = await redis.get(cacheKey).catch(() => null);
      if (cached) {
        try {
          const parsed = JSON.parse(cached) as LedgerEvent[];
          if (Array.isArray(parsed)) {
            return parsed;
          }
        } catch {
          // Ignore malformed cache entries and read from Postgres.
        }
      }
    }

    const result = await this.pool.query<LedgerRow>(
      `
        SELECT seq_id, workflow_id, event_type, event_payload, created_at
        FROM authority_ledger_events
        WHERE workflow_id = $1
        ORDER BY seq_id ASC;
      `,
      [workflowId]
    );

    const events = result.rows.map((row) => this.mapRowToEvent(row));

    if (redis) {
      await redis
        .setEx(cacheKey, this.ledgerCacheTtlSeconds, JSON.stringify(events))
        .catch(() => undefined);
    }

    return events;
  }

  async listByWorkflowIdSince(workflowId: string, sinceSeqId: number): Promise<LedgerEvent[]> {
    const result = await this.pool.query<LedgerRow>(
      `
        SELECT seq_id, workflow_id, event_type, event_payload, created_at
        FROM authority_ledger_events
        WHERE workflow_id = $1 AND seq_id > $2
        ORDER BY seq_id ASC;
      `,
      [workflowId, sinceSeqId]
    );

    return result.rows.map((row) => this.mapRowToEvent(row));
  }

  observeWorkflowEvents(workflowId: string): Observable<LedgerEvent> {
    return this.eventSubject.pipe(filter((event) => event.workflowId === workflowId));
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