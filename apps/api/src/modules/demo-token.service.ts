import { ForbiddenException, Injectable, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { Auth0AuthorityService } from './auth0-authority.service';

type DemoRole = 'ops-manager' | 'cfo' | 'dpo';

type DemoScope = 'openid' | 'execute:refund' | 'execute:data_deletion';

type RefreshRecord = {
  refreshToken: string;
  provider: string;
  subject: string;
  scope: DemoScope;
  lastRefreshedAt: Date | null;
  lastAccessTokenExpiresAt: Date | null;
};

type StatusEntry = {
  available: boolean;
  provider: string | null;
  subject: string | null;
  lastAccessTokenExpiresAt: string | null;
};

type DemoRoleRow = {
  role: DemoRole;
  refresh_token: string;
  provider: string;
  subject: string;
  scope: DemoScope;
  last_refreshed_at: Date | null;
  last_access_token_expires_at: Date | null;
};

@Injectable()
export class DemoTokenService implements OnModuleInit {
  private readonly cache = new Map<DemoRole, RefreshRecord>();
  private readonly pool: Pool;

  constructor(private readonly auth0AuthorityService: Auth0AuthorityService) {
    const connectionString = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/agentcantdothat';
    this.pool = new Pool({ connectionString });
  }

  async onModuleInit(): Promise<void> {
    await this.ensureSchema();
    await this.loadPersistedRecords();
  }

  private async ensureSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(`SELECT pg_advisory_lock(hashtext('demo_role_refresh_tokens_v1'));`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS demo_role_refresh_tokens (
          role TEXT PRIMARY KEY,
          refresh_token TEXT NOT NULL,
          provider TEXT NOT NULL,
          subject TEXT NOT NULL,
          scope TEXT NOT NULL,
          last_refreshed_at TIMESTAMPTZ NULL,
          last_access_token_expires_at TIMESTAMPTZ NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext('demo_role_refresh_tokens_v1'));`);
      client.release();
    }
  }

  private async loadPersistedRecords(): Promise<void> {
    const result = await this.pool.query<DemoRoleRow>(`
      SELECT role, refresh_token, provider, subject, scope, last_refreshed_at, last_access_token_expires_at
      FROM demo_role_refresh_tokens
      WHERE role IN ('ops-manager', 'cfo', 'dpo');
    `);

    for (const row of result.rows) {
      this.cache.set(row.role, {
        refreshToken: row.refresh_token,
        provider: row.provider,
        subject: row.subject,
        scope: row.scope,
        lastRefreshedAt: row.last_refreshed_at ? new Date(row.last_refreshed_at) : null,
        lastAccessTokenExpiresAt: row.last_access_token_expires_at ? new Date(row.last_access_token_expires_at) : null
      });
    }
  }

  private ensureEnabled() {
    if (process.env.DEMO_MODE_ENABLED !== 'true') {
      throw new ForbiddenException({ reason: 'Demo mode is disabled' });
    }
  }

  private formatBootstrapError(error: unknown): string {
    if (error instanceof ForbiddenException) {
      const response = error.getResponse();
      if (typeof response === 'string' && response.trim()) {
        return response.trim();
      }

      const body = response as { reason?: unknown; message?: unknown };
      if (typeof body?.reason === 'string' && body.reason.trim()) {
        return body.reason.trim();
      }

      if (typeof body?.message === 'string' && body.message.trim()) {
        return body.message.trim();
      }
    }

    if (error instanceof Error && error.message.trim()) {
      return error.message.trim();
    }

    return 'unknown bootstrap failure';
  }

  private extractSubject(token: string): string {
    try {
      const parts = token.split('.');
      if (parts.length < 2) {
        throw new Error('Token is not JWT');
      }

      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { sub?: string };
      if (typeof payload.sub === 'string' && payload.sub.trim()) {
        return payload.sub.trim();
      }
    } catch {
      // fallback below
    }

    return 'unknown';
  }

  private roleScope(role: DemoRole): DemoScope {
    if (role === 'ops-manager') return 'openid';
    if (role === 'cfo') return 'execute:refund';
    return 'execute:data_deletion';
  }

  private async upsertRecord(role: DemoRole, input: { refreshToken: string; provider: string; subject: string }) {
    const record: RefreshRecord = {
      refreshToken: input.refreshToken,
      provider: input.provider,
      subject: input.subject,
      scope: this.roleScope(role),
      lastRefreshedAt: null,
      lastAccessTokenExpiresAt: null
    };

    this.cache.set(role, record);

    await this.pool.query(
      `
        INSERT INTO demo_role_refresh_tokens (
          role, refresh_token, provider, subject, scope, last_refreshed_at, last_access_token_expires_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, NULL, NULL, NOW())
        ON CONFLICT (role) DO UPDATE SET
          refresh_token = EXCLUDED.refresh_token,
          provider = EXCLUDED.provider,
          subject = EXCLUDED.subject,
          scope = EXCLUDED.scope,
          last_refreshed_at = NULL,
          last_access_token_expires_at = NULL,
          updated_at = NOW();
      `,
      [role, record.refreshToken, record.provider, record.subject, record.scope]
    );
  }

  private async persistRefreshMetadata(role: DemoRole, record: RefreshRecord): Promise<void> {
    await this.pool.query(
      `
        UPDATE demo_role_refresh_tokens
        SET last_refreshed_at = $2,
            last_access_token_expires_at = $3,
            updated_at = NOW()
        WHERE role = $1;
      `,
      [role, record.lastRefreshedAt, record.lastAccessTokenExpiresAt]
    );
  }

  private getRecord(role: DemoRole): RefreshRecord | null {
    return this.cache.get(role) ?? null;
  }

  async bootstrapFromCiba(): Promise<{ roles: Record<DemoRole, StatusEntry> }> {
    this.ensureEnabled();

    const opsUserId = process.env.OPS_USER_ID?.trim();
    const cfoUserId = process.env.CFO_USER_ID?.trim();
    const dpoUserId = process.env.DPO_USER_ID?.trim();

    if (!opsUserId || !cfoUserId || !dpoUserId) {
      throw new ForbiddenException({ reason: 'Missing OPS_USER_ID / CFO_USER_ID / DPO_USER_ID for demo bootstrap' });
    }

    let opsRefresh: string;
    let cfoRefresh: string;
    let dpoRefresh: string;

    const provider = process.env.AUTH0_CONNECTION_NAME ?? 'google-oauth2';

    try {
      const ciba = await this.auth0AuthorityService.getUserRefreshTokenViaCiba({
        userId: opsUserId,
        bindingMessage: 'Demo bootstrap: ops refresh token',
        scope: 'openid'
      });
      opsRefresh = ciba.refreshToken;
    } catch (error) {
      const reason = this.formatBootstrapError(error);
      throw new ForbiddenException({ reason: `demo_bootstrap_failed[ops-manager] — ${reason}` });
    }

    try {
      const ciba = await this.auth0AuthorityService.getUserRefreshTokenViaCiba({
        userId: cfoUserId,
        bindingMessage: 'Demo bootstrap: cfo refresh token',
        scope: 'execute:refund'
      });
      cfoRefresh = ciba.refreshToken;
    } catch (error) {
      const reason = this.formatBootstrapError(error);
      throw new ForbiddenException({ reason: `demo_bootstrap_failed[cfo] — ${reason}` });
    }

    try {
      const ciba = await this.auth0AuthorityService.getUserRefreshTokenViaCiba({
        userId: dpoUserId,
        bindingMessage: 'Demo bootstrap: dpo refresh token',
        scope: 'execute:data_deletion'
      });
      dpoRefresh = ciba.refreshToken;
    } catch (error) {
      const reason = this.formatBootstrapError(error);
      throw new ForbiddenException({ reason: `demo_bootstrap_failed[dpo] — ${reason}` });
    }

    await this.upsertRecord('ops-manager', {
      refreshToken: opsRefresh,
      provider,
      subject: opsUserId
    });
    await this.upsertRecord('cfo', {
      refreshToken: cfoRefresh,
      provider,
      subject: cfoUserId
    });
    await this.upsertRecord('dpo', {
      refreshToken: dpoRefresh,
      provider,
      subject: dpoUserId
    });

    return this.status();
  }

  async clear(): Promise<{ cleared: true }> {
    this.cache.clear();
    await this.pool.query(`DELETE FROM demo_role_refresh_tokens;`);
    return { cleared: true };
  }

  status(): { roles: Record<DemoRole, StatusEntry> } {
    const roles: DemoRole[] = ['ops-manager', 'cfo', 'dpo'];
    const out = roles.reduce(
      (acc, role) => {
        const record = this.getRecord(role);
        acc[role] = {
          available: Boolean(record),
          provider: record?.provider ?? null,
          subject: record?.subject ?? null,
          lastAccessTokenExpiresAt: record?.lastAccessTokenExpiresAt ? record.lastAccessTokenExpiresAt.toISOString() : null
        };
        return acc;
      },
      {} as Record<DemoRole, StatusEntry>
    );

    return { roles: out };
  }

  async getRequiredToken(role: DemoRole): Promise<string> {
    this.ensureEnabled();
    const record = this.getRecord(role);
    if (!record) {
      throw new ForbiddenException({ reason: 'demo_token_expired — re-run bootstrap' });
    }

    try {
      const minted = await this.auth0AuthorityService.mintAccessTokenFromRefreshToken({
        refreshToken: record.refreshToken,
        scope: record.scope
      });

      record.lastRefreshedAt = new Date();
      record.lastAccessTokenExpiresAt = new Date(Date.now() + minted.expiresIn * 1000);
      await this.persistRefreshMetadata(role, record);

      return minted.accessToken;
    } catch {
      throw new ForbiddenException({ reason: 'demo_token_expired — re-run bootstrap' });
    }
  }
}
