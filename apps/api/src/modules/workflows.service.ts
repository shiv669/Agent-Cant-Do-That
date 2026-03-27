import { BadRequestException, Injectable } from '@nestjs/common';
import { Client, Connection } from '@temporalio/client';
import { Auth0AuthorityService } from './auth0-authority.service';
import { AuthorityService } from './authority.service';
import { AgentRuntimeService, type SupportedAction } from './agent-runtime.service';
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
  private static readonly ACTION_SEQUENCE: SupportedAction[] = [
    'revoke_access',
    'export_billing_history',
    'cancel_subscriptions',
    'validate_customer_state',
    'enumerate_data_stores',
    'run_compliance_check',
    'execute_refund',
    'execute_data_deletion'
  ];

  constructor(
    private readonly ledgerRepository: LedgerRepository,
    private readonly auth0AuthorityService: Auth0AuthorityService,
    private readonly authorityService: AuthorityService,
    private readonly agentRuntimeService: AgentRuntimeService,
    private readonly evidenceSheetService: EvidenceSheetService
  ) {}

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
    action: SupportedAction;
    amountUsd?: number;
    completedActions?: string[];
  }): Promise<Record<string, unknown>> {
    const decision = await this.agentRuntimeService.planAction({
      workflowId: input.workflowId,
      customerId: input.customerId,
      completedActions: input.completedActions ?? [],
      amountUsd: input.amountUsd
    });

    const agentIdByAction: Record<string, string> = {
      revoke_access: 'identity-agent-v1',
      export_billing_history: 'billing-agent-v1',
      cancel_subscriptions: 'billing-agent-v1',
      validate_customer_state: 'compliance-agent-v1',
      enumerate_data_stores: 'data-agent-v1',
      run_compliance_check: 'compliance-agent-v1',
      execute_refund: 'billing-agent-v1',
      execute_data_deletion: 'data-agent-v1'
    };

    const resolvedAgentId = agentIdByAction[input.action] ?? 'orchestrator-agent-v1';

    return {
      actor: resolvedAgentId,
      agentId: resolvedAgentId,
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
    completedActions?: string[];
  }): Promise<{ blocked: boolean }> {
    const action = input.actionScope === 'execute:refund' ? 'execute_refund' : 'execute_data_deletion';
    const metadata = await this.agentMetadata({
      workflowId: input.workflowId,
      customerId: input.customerId,
      action,
      amountUsd: input.amountUsd,
      completedActions: input.completedActions
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
      return { blocked: false };
    } catch {
      // Blocked attempts are expected and recorded in the append-only ledger.
      return { blocked: true };
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

  private deriveCompletedActions(events: LedgerEvent[]): SupportedAction[] {
    const completed = new Set<SupportedAction>();

    for (const event of events) {
      switch (event.eventType) {
        case 'revoke_sso_access_completed':
          completed.add('revoke_access');
          break;
        case 'billing_history_exported':
          completed.add('export_billing_history');
          break;
        case 'subscriptions_cancelled':
          completed.add('cancel_subscriptions');
          break;
        case 'customer_validation_passed':
          completed.add('validate_customer_state');
          break;
        case 'data_stores_enumerated':
          completed.add('enumerate_data_stores');
          break;
        case 'compliance_check_passed':
          completed.add('run_compliance_check');
          break;
        case 'authority_window_consumed': {
          const payload = event.payload as Record<string, unknown>;
          if (payload.actionScope === 'execute:refund') {
            completed.add('execute_refund');
          }
          if (payload.actionScope === 'execute:data_deletion') {
            completed.add('execute_data_deletion');
          }
          break;
        }
        default:
          break;
      }
    }

    return [...completed];
  }

  private nextIncompleteAction(completedActions: readonly string[]): SupportedAction {
    const completed = new Set(completedActions);
    for (const action of WorkflowsService.ACTION_SEQUENCE) {
      if (!completed.has(action)) {
        return action;
      }
    }

    return 'execute_data_deletion';
  }

  async planNextAction(input: {
    workflowId: string;
    customerId: string;
    refundAmountUsd: number;
  }): Promise<{ nextAction: SupportedAction; reasoning: string; actionReason: string; completedActions: string[] }> {
    const events = await this.ledgerRepository.listByWorkflowId(input.workflowId);
    const completedActions = this.deriveCompletedActions(events);

    const decision = await this.agentRuntimeService.planAction({
      workflowId: input.workflowId,
      customerId: input.customerId,
      completedActions,
      amountUsd: input.refundAmountUsd
    });

    const completedSet = new Set(completedActions);
    const nextAction = completedSet.has(decision.action)
      ? this.nextIncompleteAction(completedActions)
      : decision.action;

    return {
      nextAction,
      reasoning: decision.reasoning,
      actionReason: decision.actionReason,
      completedActions
    };
  }

  async executeActionStep(input: {
    workflowId: string;
    customerId: string;
    action: SupportedAction;
    refundAmountUsd: number;
    opsSubjectToken?: string;
    completedActions?: string[];
  }): Promise<{ action: SupportedAction; blocked: boolean; completed: boolean }> {
    // Guard against duplicate activity retries or non-monotonic planning outputs.
    const existingEvents = await this.ledgerRepository.listByWorkflowId(input.workflowId);
    const alreadyCompleted = new Set(this.deriveCompletedActions(existingEvents));
    if (alreadyCompleted.has(input.action)) {
      return { action: input.action, blocked: false, completed: true };
    }

    const requireTokenVaultExport = process.env.TOKEN_VAULT_BILLING_EXPORT_REQUIRED === 'true';
    const metadata = await this.agentMetadata({
      workflowId: input.workflowId,
      customerId: input.customerId,
      action: input.action,
      amountUsd: input.refundAmountUsd,
      completedActions: input.completedActions
    });

    switch (input.action) {
      case 'revoke_access':
        await this.appendEvent(input.workflowId, 'revoke_sso_access_completed', {
          provider: 'enterprise_sso',
          ...metadata
        });
        return { action: input.action, blocked: false, completed: true };
      case 'export_billing_history': {
        let billingExportPayload: Record<string, unknown>;
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
              stage: 'billing_history_exported',
              ...metadata
            });
            return { action: input.action, blocked: true, completed: false };
          }

          billingExportPayload = {
            exportFormat: 'csv',
            tokenSource: 'none',
            reason: error instanceof Error ? error.message : 'Token Vault billing export failed'
          };
        }

        await this.appendEvent(input.workflowId, 'billing_history_exported', {
          ...billingExportPayload,
          ...metadata
        });
        return { action: input.action, blocked: false, completed: true };
      }
      case 'cancel_subscriptions':
        await this.appendEvent(input.workflowId, 'subscriptions_cancelled', {
          cancelledCount: 3,
          ...metadata
        });
        return { action: input.action, blocked: false, completed: true };
      case 'validate_customer_state':
        await this.appendEvent(input.workflowId, 'customer_validation_passed', {
          customerId: input.customerId,
          status: 'active',
          ...metadata
        });
        return { action: input.action, blocked: false, completed: true };
      case 'enumerate_data_stores':
        await this.appendEvent(input.workflowId, 'data_stores_enumerated', {
          storeCount: 14,
          ...metadata
        });
        return { action: input.action, blocked: false, completed: true };
      case 'run_compliance_check':
        await this.appendEvent(input.workflowId, 'compliance_check_passed', {
          legalHolds: 0,
          offboardingPermitted: true,
          ...metadata
        });
        return { action: input.action, blocked: false, completed: true };
      case 'execute_refund': {
        const result = await this.attemptHighRiskAction({
          workflowId: input.workflowId,
          customerId: input.customerId,
          actionScope: 'execute:refund',
          amountUsd: input.refundAmountUsd,
          completedActions: input.completedActions
        });
        return { action: input.action, blocked: result.blocked, completed: !result.blocked };
      }
      case 'execute_data_deletion': {
        const result = await this.attemptHighRiskAction({
          workflowId: input.workflowId,
          customerId: input.customerId,
          actionScope: 'execute:data_deletion',
          completedActions: input.completedActions
        });
        return { action: input.action, blocked: result.blocked, completed: !result.blocked };
      }
      default:
        return { action: input.action, blocked: true, completed: false };
    }
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
      args: [
        {
          workflowId,
          customerId: input.customerId,
          refundAmountUsd,
          opsSubjectToken
        }
      ]
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
