import { Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import type { ActionScope, AuthorityWindowStatus } from '@contracts/index';

export type AuthorityWindowRecord = {
  window_id: string;
  workflow_id: string;
  action_scope: Extract<ActionScope, 'execute:refund' | 'execute:data_deletion'>;
  bound_agent_client_id: string;
  claimant_agent_client_id: string | null;
  status: AuthorityWindowStatus;
  authority_window_token: string | null;
  expires_at: Date;
  claimed_at: Date | null;
  consumed_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
};

@Injectable()
export class AuthorityWindowRepository {
  private readonly pool: Pool;

  constructor() {
    const connectionString = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/acdt';
    this.pool = new Pool({ connectionString });
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS authority_windows (
        window_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        action_scope TEXT NOT NULL,
        bound_agent_client_id TEXT NOT NULL,
        claimant_agent_client_id TEXT NULL,
        status TEXT NOT NULL,
        authority_window_token TEXT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        claimed_at TIMESTAMPTZ NULL,
        consumed_at TIMESTAMPTZ NULL,
        revoked_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_authority_windows_workflow_status
      ON authority_windows (workflow_id, status, created_at DESC);
    `);
  }

  async insertWindow(input: {
    windowId: string;
    workflowId: string;
    actionScope: Extract<ActionScope, 'execute:refund' | 'execute:data_deletion'>;
    boundAgentClientId: string;
    status: AuthorityWindowStatus;
    expiresAt: Date;
  }): Promise<AuthorityWindowRecord> {
    const result = await this.pool.query<AuthorityWindowRecord>(
      `
        INSERT INTO authority_windows (
          window_id,
          workflow_id,
          action_scope,
          bound_agent_client_id,
          status,
          expires_at
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *;
      `,
      [
        input.windowId,
        input.workflowId,
        input.actionScope,
        input.boundAgentClientId,
        input.status,
        input.expiresAt.toISOString()
      ]
    );

    return result.rows[0];
  }

  async findWindow(windowId: string): Promise<AuthorityWindowRecord | null> {
    const result = await this.pool.query<AuthorityWindowRecord>(
      `SELECT * FROM authority_windows WHERE window_id = $1;`,
      [windowId]
    );

    return result.rows[0] ?? null;
  }

  async markClaimed(input: {
    windowId: string;
    claimantAgentClientId: string;
    authorityWindowToken: string;
  }): Promise<AuthorityWindowRecord | null> {
    const result = await this.pool.query<AuthorityWindowRecord>(
      `
        UPDATE authority_windows
        SET
          status = 'claimed',
          claimant_agent_client_id = $2,
          authority_window_token = $3,
          claimed_at = NOW()
        WHERE window_id = $1
          AND status = 'requested'
          AND NOW() < expires_at
        RETURNING *;
      `,
      [input.windowId, input.claimantAgentClientId, input.authorityWindowToken]
    );

    return result.rows[0] ?? null;
  }

  async markConsumed(windowId: string): Promise<AuthorityWindowRecord | null> {
    const result = await this.pool.query<AuthorityWindowRecord>(
      `
        UPDATE authority_windows
        SET
          status = 'consumed',
          consumed_at = NOW()
        WHERE window_id = $1
          AND status = 'claimed'
        RETURNING *;
      `,
      [windowId]
    );

    return result.rows[0] ?? null;
  }

  async markRevoked(windowId: string): Promise<AuthorityWindowRecord | null> {
    const result = await this.pool.query<AuthorityWindowRecord>(
      `
        UPDATE authority_windows
        SET
          status = 'revoked',
          revoked_at = NOW()
        WHERE window_id = $1
          AND status IN ('claimed', 'consumed')
        RETURNING *;
      `,
      [windowId]
    );

    return result.rows[0] ?? null;
  }

  async markExpiredWindows(): Promise<void> {
    await this.pool.query(`
      UPDATE authority_windows
      SET status = 'expired'
      WHERE status = 'requested'
        AND NOW() >= expires_at;
    `);
  }
}
