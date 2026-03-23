import { Injectable } from '@nestjs/common';
import { Client, Connection } from '@temporalio/client';
import { Auth0AuthorityService } from './auth0-authority.service';
import { LedgerRepository } from './ledger.repository';
import type {
  LedgerEvent,
  StartOffboardingInput,
  StartOffboardingResponse,
  WorkflowStatusResponse
} from '@contracts/index';
import type { OnModuleInit } from '@nestjs/common';

@Injectable()
export class WorkflowsService implements OnModuleInit {
  constructor(
    private readonly ledgerRepository: LedgerRepository,
    private readonly auth0AuthorityService: Auth0AuthorityService
  ) {}

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async onModuleInit(): Promise<void> {
    await this.ledgerRepository.ensureSchema();
  }

  private async getTemporalClient(): Promise<Client> {
    const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
    const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';

    const connection = await Connection.connect({ address });
    return new Client({ connection, namespace });
  }

  private async appendEvent(workflowId: string, eventType: LedgerEvent['eventType'], payload: Record<string, unknown>) {
    await this.ledgerRepository.appendEvent({
      workflowId,
      eventType,
      payload
    });
  }

  private async resolveOpsSubjectToken(opsSubjectToken?: string): Promise<string> {
    if (opsSubjectToken) {
      return opsSubjectToken;
    }

    const opsUserId = process.env.OPS_USER_ID?.trim();
    if (opsUserId) {
      const ciba = await this.auth0AuthorityService.getUserSubjectTokenViaCiba({
        userId: opsUserId,
        bindingMessage: 'Approve billing export via Token Vault',
        scope: 'openid'
      });

      return ciba.subjectToken;
    }

    const domain = process.env.AUTH0_DOMAIN?.trim();
    const clientId = process.env.AUTH0_CLIENT_ID?.trim();
    const clientSecret = process.env.AUTH0_CLIENT_SECRET?.trim();
    const audience = process.env.AUTH0_AUDIENCE?.trim();
    const opsEmail = process.env.OPS_MANAGER_EMAIL?.trim() || 'ops@agentcantdothat.dev';
    const opsPassword = process.env.OPS_MANAGER_PASSWORD?.trim();
    const passwordRealm = process.env.AUTH0_PASSWORD_REALM?.trim() || 'Username-Password-Authentication';

    if (domain && clientId && clientSecret && audience && opsPassword) {
      const response = await fetch(`https://${domain}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'http://auth0.com/oauth/grant-type/password-realm',
          client_id: clientId,
          client_secret: clientSecret,
          username: opsEmail,
          password: opsPassword,
          realm: passwordRealm,
          scope: 'openid profile email offline_access',
          audience
        })
      });

      const payload = (await response.json().catch(() => ({}))) as {
        access_token?: string;
        error?: string;
        error_description?: string;
      };

      if (response.ok && payload.access_token) {
        return payload.access_token;
      }
    }

    throw new Error('Unable to resolve Ops subject token (no OPS_USER_ID and password-realm fallback failed)');
  }

  private async createGoogleSheet(input: { accessToken: string; customerId: string; workflowId: string }): Promise<string> {
    const createResponse = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        properties: {
          title: `Billing Export ${input.customerId} ${new Date().toISOString().slice(0, 10)}`
        },
        sheets: [{ properties: { title: 'BillingHistory' } }]
      })
    });

    if (!createResponse.ok) {
      const text = await createResponse.text();
      throw new Error(`Google Sheets create failed (${createResponse.status}): ${text}`);
    }

    const createPayload = (await createResponse.json()) as { spreadsheetUrl?: string; spreadsheetId?: string };
    const spreadsheetUrl =
      createPayload.spreadsheetUrl ??
      (createPayload.spreadsheetId
        ? `https://docs.google.com/spreadsheets/d/${createPayload.spreadsheetId}`
        : undefined);

    if (!spreadsheetUrl) {
      throw new Error('Google Sheets response missing spreadsheet URL');
    }

    const now = new Date().toISOString();
    const rows = [
      ['invoice_id', 'customer_id', 'period', 'amount_usd', 'status', 'exported_at'],
      ['inv-1001', input.customerId, '2026-01', '199.00', 'paid', now],
      ['inv-1002', input.customerId, '2026-02', '199.00', 'paid', now],
      ['inv-1003', input.customerId, '2026-03', '199.00', 'due', now],
      ['workflow_id', input.workflowId, '', '', '', now]
    ];

    if (!createPayload.spreadsheetId) {
      throw new Error('Google Sheets response missing spreadsheetId for data write');
    }

    const valuesResponse = await fetch(
      'https://sheets.googleapis.com/v4/spreadsheets/' +
        encodeURIComponent(createPayload.spreadsheetId) +
        '/values/BillingHistory!A1:append?valueInputOption=RAW',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ values: rows })
      }
    );

    if (!valuesResponse.ok) {
      const text = await valuesResponse.text();
      throw new Error(`Google Sheets write failed (${valuesResponse.status}): ${text}`);
    }

    return spreadsheetUrl;
  }

  private async exportBillingHistoryViaTokenVault(input: {
    customerId: string;
    workflowId: string;
    opsSubjectToken?: string;
  }): Promise<Record<string, unknown>> {
    const resolvedOpsSubjectToken = await this.resolveOpsSubjectToken(input.opsSubjectToken);

    const providerToken = await this.auth0AuthorityService.mintProviderAccessToken({
      subjectToken: resolvedOpsSubjectToken,
      connection: process.env.AUTH0_CONNECTION_NAME ?? 'google-oauth2',
      loginHint: process.env.OPS_TOKEN_VAULT_LOGIN_HINT
    });

    const sheetUrl = await this.createGoogleSheet({
      accessToken: providerToken.accessToken,
      customerId: input.customerId,
      workflowId: input.workflowId
    });

    const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${providerToken.accessToken}`
      }
    });

    if (!userInfoResponse.ok) {
      const text = await userInfoResponse.text();
      throw new Error(`Google userinfo probe failed (${userInfoResponse.status}): ${text}`);
    }

    const userInfo = (await userInfoResponse.json()) as { email?: string };

    return {
      exportFormat: 'google_sheets',
      sheetUrl,
      tokenSource: 'Auth0 Token Vault',
      connection: process.env.AUTH0_CONNECTION_NAME ?? 'google-oauth2',
      opsUserId: process.env.OPS_USER_ID ?? 'unknown',
      exporterIdentity: userInfo.email ?? 'unknown',
      tokenTtlSeconds: providerToken.expiresIn
    };
  }

  async startOffboarding(input: StartOffboardingInput): Promise<StartOffboardingResponse> {
    const workflowId = `offboarding-${input.customerId}-${Date.now()}`;
    const opsSubjectToken = (input as StartOffboardingInput & { opsSubjectToken?: string }).opsSubjectToken;

    const client = await this.getTemporalClient();

    await client.workflow.start('customerOffboardingWorkflow', {
      taskQueue: 'acdt-task-queue',
      workflowId,
      args: [input]
    });

    await this.sleep(500);
    await this.appendEvent(workflowId, 'revoke_sso_access_completed', {
      provider: 'enterprise_sso'
    });

    await this.sleep(500);
    const requireTokenVaultExport = process.env.TOKEN_VAULT_BILLING_EXPORT_REQUIRED === 'true';
    let billingExportPayload: Record<string, unknown>;
    try {
      billingExportPayload = await this.exportBillingHistoryViaTokenVault({
        customerId: input.customerId,
        workflowId,
        opsSubjectToken
      });
    } catch (error) {
      if (requireTokenVaultExport) {
        const reason = error instanceof Error ? error.message : 'Token Vault billing export failed';
        throw new Error(reason);
      }

      billingExportPayload = {
        exportFormat: 'csv',
        tokenSource: 'none',
        reason: error instanceof Error ? error.message : 'Token Vault billing export failed'
      };
    }

    await this.appendEvent(workflowId, 'billing_history_exported', {
      ...billingExportPayload
    });

    await this.sleep(500);
    await this.appendEvent(workflowId, 'subscriptions_cancelled', {
      cancelledCount: 3
    });

    await this.sleep(1500);
    await this.appendEvent(workflowId, 'customer_validation_passed', {
      customerId: input.customerId,
      status: 'active'
    });

    await this.sleep(2000);
    await this.appendEvent(workflowId, 'data_stores_enumerated', {
      storeCount: 14
    });

    await this.sleep(1000);
    await this.appendEvent(workflowId, 'compliance_check_passed', {
      legalHolds: 0,
      offboardingPermitted: true
    });

    return {
      workflowId,
      customerId: input.customerId,
      status: 'blocked-awaiting-authority'
    };
  }

  async getStatus(workflowId: string): Promise<WorkflowStatusResponse> {
    return {
      workflowId,
      status: 'blocked-awaiting-authority'
    };
  }

  async getLedger(workflowId: string): Promise<LedgerEvent[]> {
    return this.ledgerRepository.listByWorkflowId(workflowId);
  }
}
