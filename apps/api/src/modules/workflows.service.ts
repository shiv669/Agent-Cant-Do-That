import { BadRequestException, Injectable } from '@nestjs/common';
import { Client, Connection } from '@temporalio/client';
import { Auth0AuthorityService } from './auth0-authority.service';
import { AuthorityService } from './authority.service';
import { AgentRuntimeService } from './agent-runtime.service';
import { LedgerRepository } from './ledger.repository';
import { EvidenceSheetService } from './evidence-sheet.service';
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
    private readonly auth0AuthorityService: Auth0AuthorityService,
    private readonly authorityService: AuthorityService,
    private readonly agentRuntimeService: AgentRuntimeService,
    private readonly evidenceSheetService: EvidenceSheetService
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

  private async agentMetadata(input: {
    workflowId: string;
    customerId: string;
    action:
      | 'revoke_access'
      | 'export_billing_history'
      | 'cancel_subscriptions'
      | 'validate_customer_state'
      | 'enumerate_data_stores'
      | 'run_compliance_check'
      | 'execute_refund'
      | 'execute_data_deletion';
    amountUsd?: number;
  }): Promise<Record<string, unknown>> {
    const decision = await this.agentRuntimeService.planAction({
      workflowId: input.workflowId,
      customerId: input.customerId,
      action: input.action,
      amountUsd: input.amountUsd
    });

    return {
      actor: 'autonomous_agent',
      agentId: 'orchestrator-agent-v1',
      actionName: decision.action,
      actionReason: decision.actionReason,
      reasoning: decision.reasoning,
      decisionSource: decision.decisionSource,
      modelProvider: decision.modelProvider,
      modelName: decision.modelName
    };
  }

  private async attemptHighRiskAction(input: {
    workflowId: string;
    customerId: string;
    actionScope: 'execute:refund' | 'execute:data_deletion';
    amountUsd?: number;
  }): Promise<void> {
    const action = input.actionScope === 'execute:refund' ? 'execute_refund' : 'execute_data_deletion';
    const metadata = await this.agentMetadata({
      workflowId: input.workflowId,
      customerId: input.customerId,
      action,
      amountUsd: input.amountUsd
    });

    try {
      await this.authorityService.checkHighRiskAction({
        workflowId: input.workflowId,
        actionScope: input.actionScope,
        actionReason: metadata.actionReason as string,
        reasoning: metadata.reasoning as string,
        decisionSource: metadata.decisionSource as string,
        modelProvider: metadata.modelProvider as string,
        modelName: metadata.modelName as string
      });
    } catch {
      // Blocked attempts are expected and recorded in the append-only ledger.
    }
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

  private async createGoogleSheet(input: {
    accessToken: string;
    customerId: string;
    workflowId: string;
    refundAmountUsd: number;
    initialLedgerEvents: LedgerEvent[];
  }): Promise<{ spreadsheetId: string; sheetUrl: string; publicSheetUrl: string; isPublic: boolean; evidenceEntries: Array<{ key: string; value: string }> }> {
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
        sheets: [{ properties: { title: 'BillingHistory' } }, { properties: { title: 'LiveFeed' } }, { properties: { title: 'Summary' } }]
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

    if (!createPayload.spreadsheetId) {
      throw new Error('Google Sheets response missing spreadsheetId for data write');
    }

    const spreadsheetId = createPayload.spreadsheetId;
    const publicSheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit?usp=sharing`;

    const now = new Date().toISOString();
    const billingRows = [
      ['record_type', 'workflow_id', 'seq_id', 'event_type', 'action_scope', 'action_reason', 'reasoning', 'created_at'],
      ...input.initialLedgerEvents.map((event) => {
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        return [
          'ledger_event',
          event.workflowId,
          String(event.seqId),
          event.eventType,
          typeof payload.actionScope === 'string' ? payload.actionScope : '',
          typeof payload.actionReason === 'string' ? payload.actionReason : '',
          typeof payload.reasoning === 'string' ? payload.reasoning : '',
          event.createdAt
        ];
      }),
      [
        'refund_plan',
        input.workflowId,
        '',
        'execute:refund',
        'execute:refund',
        'Configured refund amount for this workflow',
        '',
        `${input.refundAmountUsd.toFixed(2)} USD`
      ]
    ];

    const evidenceEntries = [
      { key: 'workflow_id', value: input.workflowId },
      { key: 'customer_id', value: input.customerId },
      { key: 'token_source', value: 'Auth0 Token Vault' },
      { key: 'token_exchange_mode', value: 'runtime exchange (no stored provider tokens)' },
      { key: 'connection', value: process.env.AUTH0_CONNECTION_NAME ?? 'google-oauth2' },
      { key: 'refund_amount_usd', value: input.refundAmountUsd.toFixed(2) },
      { key: 'exported_at', value: now },
      { key: 'public_sheet_url', value: publicSheetUrl }
    ];

    const summaryRows = [
      ['evidence_key', 'evidence_value'],
      ...evidenceEntries.map((entry) => [entry.key, entry.value])
    ];

    const valuesResponse = await fetch(
      'https://sheets.googleapis.com/v4/spreadsheets/' +
        encodeURIComponent(spreadsheetId) +
        '/values/BillingHistory!A1:append?valueInputOption=RAW',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ values: billingRows })
      }
    );

    if (!valuesResponse.ok) {
      const text = await valuesResponse.text();
      throw new Error(`Google Sheets write failed (${valuesResponse.status}): ${text}`);
    }

    const summaryResponse = await fetch(
      'https://sheets.googleapis.com/v4/spreadsheets/' +
        encodeURIComponent(spreadsheetId) +
        '/values/Summary!A1:append?valueInputOption=RAW',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ values: summaryRows })
      }
    );

    if (!summaryResponse.ok) {
      const text = await summaryResponse.text();
      throw new Error(`Google Sheets summary write failed (${summaryResponse.status}): ${text}`);
    }

    let isPublic = false;
    const permissionResponse = await fetch(
      'https://www.googleapis.com/drive/v3/files/' +
        encodeURIComponent(spreadsheetId) +
        '/permissions?supportsAllDrives=true&sendNotificationEmail=false',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          role: 'reader',
          type: 'anyone'
        })
      }
    );

    if (permissionResponse.ok) {
      isPublic = true;
    }

    return { spreadsheetId, sheetUrl: spreadsheetUrl, publicSheetUrl, isPublic, evidenceEntries };
  }

  private async exportBillingHistoryViaTokenVault(input: {
    customerId: string;
    workflowId: string;
    opsSubjectToken?: string;
    refundAmountUsd: number;
  }): Promise<Record<string, unknown>> {
    const resolvedOpsSubjectToken = await this.resolveOpsSubjectToken(input.opsSubjectToken);

    const providerToken = await this.auth0AuthorityService.mintProviderAccessToken({
      subjectToken: resolvedOpsSubjectToken,
      connection: process.env.AUTH0_CONNECTION_NAME ?? 'google-oauth2',
      loginHint: process.env.OPS_TOKEN_VAULT_LOGIN_HINT
    });

    const preExportEvents = await this.ledgerRepository.listByWorkflowId(input.workflowId);

    const sheet = await this.createGoogleSheet({
      accessToken: providerToken.accessToken,
      customerId: input.customerId,
      workflowId: input.workflowId,
      refundAmountUsd: input.refundAmountUsd,
      initialLedgerEvents: preExportEvents
    });

    await this.evidenceSheetService.registerWorkflowSheet({
      workflowId: input.workflowId,
      spreadsheetId: sheet.spreadsheetId,
      accessToken: providerToken.accessToken
    });

    const existingEvents = await this.ledgerRepository.listByWorkflowId(input.workflowId);
    await this.evidenceSheetService.seedWorkflowEvents(input.workflowId, existingEvents);

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
      sheetUrl: sheet.sheetUrl,
      publicSheetUrl: sheet.publicSheetUrl,
      isPublic: sheet.isPublic,
      evidenceEntries: sheet.evidenceEntries,
      tokenSource: 'Auth0 Token Vault',
      connection: process.env.AUTH0_CONNECTION_NAME ?? 'google-oauth2',
      opsUserId: process.env.OPS_USER_ID ?? 'unknown',
      exporterIdentity: userInfo.email ?? 'unknown',
      tokenTtlSeconds: providerToken.expiresIn
    };
  }

  private async executeOffboardingInBackground(input: {
    workflowId: string;
    customerId: string;
    opsSubjectToken?: string;
    refundAmountUsd: number;
  }): Promise<void> {
    const requireTokenVaultExport = process.env.TOKEN_VAULT_BILLING_EXPORT_REQUIRED === 'true';

    await this.sleep(500);
    const revokeMetadata = await this.agentMetadata({
      workflowId: input.workflowId,
      customerId: input.customerId,
      action: 'revoke_access'
    });
    await this.appendEvent(input.workflowId, 'revoke_sso_access_completed', {
      provider: 'enterprise_sso',
      ...revokeMetadata
    });

    await this.sleep(500);
    let billingExportPayload: Record<string, unknown>;
    const billingMetadata = await this.agentMetadata({
      workflowId: input.workflowId,
      customerId: input.customerId,
      action: 'export_billing_history'
    });
    try {
      billingExportPayload = await this.exportBillingHistoryViaTokenVault({
        customerId: input.customerId,
        workflowId: input.workflowId,
        opsSubjectToken: input.opsSubjectToken,
        refundAmountUsd: input.refundAmountUsd
      });
    } catch (error) {
      if (requireTokenVaultExport) {
        const reason = error instanceof Error ? error.message : 'Token Vault billing export failed';
        await this.appendEvent(input.workflowId, 'authorization_blocked', {
          reason,
          stage: 'billing_history_exported'
        });
        return;
      }

      billingExportPayload = {
        exportFormat: 'csv',
        tokenSource: 'none',
        reason: error instanceof Error ? error.message : 'Token Vault billing export failed'
      };
    }

    await this.appendEvent(input.workflowId, 'billing_history_exported', {
      ...billingExportPayload,
      ...billingMetadata
    });

    await this.sleep(500);
    const subscriptionMetadata = await this.agentMetadata({
      workflowId: input.workflowId,
      customerId: input.customerId,
      action: 'cancel_subscriptions'
    });
    await this.appendEvent(input.workflowId, 'subscriptions_cancelled', {
      cancelledCount: 3,
      ...subscriptionMetadata
    });

    await this.sleep(1500);
    const validationMetadata = await this.agentMetadata({
      workflowId: input.workflowId,
      customerId: input.customerId,
      action: 'validate_customer_state'
    });
    await this.appendEvent(input.workflowId, 'customer_validation_passed', {
      customerId: input.customerId,
      status: 'active',
      ...validationMetadata
    });

    await this.sleep(2000);
    const enumerateMetadata = await this.agentMetadata({
      workflowId: input.workflowId,
      customerId: input.customerId,
      action: 'enumerate_data_stores'
    });
    await this.appendEvent(input.workflowId, 'data_stores_enumerated', {
      storeCount: 14,
      ...enumerateMetadata
    });

    await this.sleep(1000);
    const complianceMetadata = await this.agentMetadata({
      workflowId: input.workflowId,
      customerId: input.customerId,
      action: 'run_compliance_check'
    });
    await this.appendEvent(input.workflowId, 'compliance_check_passed', {
      legalHolds: 0,
      offboardingPermitted: true,
      ...complianceMetadata
    });

    await this.sleep(500);
    await this.attemptHighRiskAction({
      workflowId: input.workflowId,
      customerId: input.customerId,
      actionScope: 'execute:refund',
      amountUsd: input.refundAmountUsd
    });
  }

  async startOffboarding(input: StartOffboardingInput): Promise<StartOffboardingResponse> {
    const workflowId = `offboarding-${input.customerId}-${Date.now()}`;
    const opsSubjectToken = (input as StartOffboardingInput & { opsSubjectToken?: string }).opsSubjectToken;
    const parsedRefund = Number(input.refundAmountUsd);
    if (!Number.isFinite(parsedRefund) || parsedRefund <= 0) {
      throw new BadRequestException('refundAmountUsd must be a positive number');
    }
    const refundAmountUsd = parsedRefund;

    const client = await this.getTemporalClient();

    await client.workflow.start('customerOffboardingWorkflow', {
      taskQueue: 'acdt-task-queue',
      workflowId,
      args: [input]
    });

    void this.executeOffboardingInBackground({
      workflowId,
      customerId: input.customerId,
      opsSubjectToken,
      refundAmountUsd
    }).catch(async (error: unknown) => {
      await this.appendEvent(workflowId, 'authorization_blocked', {
        reason: error instanceof Error ? error.message : 'Offboarding execution failed',
        stage: 'background_execution'
      });
    });

    return {
      workflowId,
      customerId: input.customerId,
      status: 'running'
    };
  }

  async getStatus(workflowId: string): Promise<WorkflowStatusResponse> {
    const events = await this.ledgerRepository.listByWorkflowId(workflowId);

    const hasFailure = events.some((event) => event.eventType === 'authorization_blocked');
    if (hasFailure) {
      return {
        workflowId,
        status: 'failed'
      };
    }

    const hasDeletionConsumed = events.some((event) => {
      if (event.eventType !== 'authority_window_consumed') return false;
      const payload = event.payload as Record<string, unknown>;
      return payload.actionScope === 'execute:data_deletion';
    });

    if (hasDeletionConsumed) {
      return {
        workflowId,
        status: 'completed'
      };
    }

    const hasRefundBlocked = events.some((event) => {
      if (event.eventType !== 'high_risk_action_blocked') return false;
      const payload = event.payload as Record<string, unknown>;
      return payload.actionScope === 'execute:refund';
    });

    return {
      workflowId,
      status: hasRefundBlocked ? 'blocked-awaiting-authority' : 'running'
    };
  }

  async getLedger(workflowId: string): Promise<LedgerEvent[]> {
    return this.ledgerRepository.listByWorkflowId(workflowId);
  }
}
