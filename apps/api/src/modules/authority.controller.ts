import { Body, Controller, ForbiddenException, Get, Param, Post, Query, Req, Sse } from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import type { Observable } from 'rxjs';
import type {
  AuthorityWindowClaimInput,
  AuthorityWindowConsumeInput,
  AuthorityWindowReplayAttemptInput,
  AuthorityWindowRequestInput,
  EscalationAttemptInput,
  HighRiskAuthorityCheckInput
} from '@contracts/index';
import { AuthorityService } from './authority.service';
import { DemoTokenService } from './demo-token.service';
import {
  AuthorityWindowClaimBodyDto,
  AuthorityWindowConsumeBodyDto,
  AuthorityWindowReplayBodyDto,
  AuthorityWindowRequestBodyDto,
  EscalationAttemptBodyDto,
  HighRiskCheckBodyDto,
  LedgerStreamQueryDto,
  WindowIdParamDto,
  WorkflowIdParamDto
} from './dto/authority.dto';

@Controller('authority')
export class AuthorityController {
  constructor(
    private readonly authorityService: AuthorityService,
    private readonly demoTokenService: DemoTokenService
  ) {}

  private getAgentClientId(request: { headers: Record<string, string | string[] | undefined> }): string {
    const header = request.headers['x-agent-client-id'];
    const value = Array.isArray(header) ? header[0] : header;
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) {
      throw new ForbiddenException({ reason: 'Missing x-agent-client-id request context' });
    }

    return normalized;
  }

  @Post('high-risk/check')
  async checkHighRiskAction(@Body() body: HighRiskCheckBodyDto, @Req() req: { headers: Record<string, string | string[] | undefined> }) {
    this.getAgentClientId(req);
    return this.authorityService.checkHighRiskAction(body as HighRiskAuthorityCheckInput);
  }

  @Post('escalate')
  async escalate(@Body() body: EscalationAttemptBodyDto, @Req() req: { headers: Record<string, string | string[] | undefined> }) {
    this.getAgentClientId(req);
    return this.authorityService.recordEscalationAttempt(body as EscalationAttemptInput);
  }

  @Post('window/request')
  async requestAuthorityWindow(
    @Body() body: AuthorityWindowRequestBodyDto,
    @Req() req: { headers: Record<string, string | string[] | undefined> }
  ) {
    const agentClientId = this.getAgentClientId(req);

    const normalized: AuthorityWindowRequestInput & { demoMode?: boolean; demoSubjectToken?: string } = {
      workflowId: body.workflowId,
      customerId: body.customerId,
      actionScope: (body.actionScope ?? body.scope) as AuthorityWindowRequestInput['actionScope'],
      requestingAgentClientId: agentClientId,
      boundAgentClientId: body.boundAgentClientId ?? body.agentId ?? 'subagent-d-client',
      amount: body.amount,
      ttlSeconds: body.ttlSeconds,
      actionReason: body.actionReason,
      reasoning: body.reasoning
    };

    if (body.demoMode) {
      normalized.demoMode = true;
      normalized.demoSubjectToken =
        normalized.actionScope === 'execute:refund'
          ? await this.demoTokenService.getRequiredToken('cfo')
          : await this.demoTokenService.getRequiredToken('dpo');
    }

    return this.authorityService.requestAuthorityWindow(normalized);
  }

  @Post('window/claim')
  async claimAuthorityWindow(
    @Body() body: AuthorityWindowClaimBodyDto,
    @Req() req: { headers: Record<string, string | string[] | undefined> }
  ) {
    const agentClientId = this.getAgentClientId(req);
    const normalized: AuthorityWindowClaimInput = {
      windowId: body.windowId,
      claimantAgentClientId: agentClientId
    };
    return this.authorityService.claimAuthorityWindow(normalized);
  }

  @Post('window/consume')
  async consumeAuthorityWindow(
    @Body() body: AuthorityWindowConsumeBodyDto,
    @Req() req: { headers: Record<string, string | string[] | undefined> }
  ) {
    const agentClientId = this.getAgentClientId(req);
    const normalized: AuthorityWindowConsumeInput = {
      windowId: body.windowId,
      claimantAgentClientId: agentClientId,
      actionReason: body.actionReason,
      reasoning: body.reasoning
    };
    return this.authorityService.consumeAuthorityWindow(normalized);
  }

  @Post('window/replay-attempt')
  async replayAttempt(
    @Body() body: AuthorityWindowReplayBodyDto,
    @Req() req: { headers: Record<string, string | string[] | undefined> }
  ) {
    const agentClientId = this.getAgentClientId(req);
    const normalized: AuthorityWindowReplayAttemptInput = {
      windowId: body.windowId,
      claimantAgentClientId: agentClientId
    };
    return this.authorityService.replayAttempt(normalized);
  }

  @Get('window/:windowId')
  async getWindow(@Param() params: WindowIdParamDto) {
    return this.authorityService.getWindow(params.windowId);
  }

  @Get('ledger/:workflowId')
  async getWorkflowLedger(@Param() params: WorkflowIdParamDto) {
    return this.authorityService.getWorkflowLedger(params.workflowId);
  }

  @Sse('ledger/:workflowId/stream')
  streamWorkflowLedger(
    @Param() params: WorkflowIdParamDto,
    @Query() query: LedgerStreamQueryDto,
    @Req() req?: { headers?: Record<string, string | string[] | undefined> }
  ): Observable<MessageEvent> {
    const lastEventHeader = req?.headers?.['last-event-id'];
    const lastEventIdRaw = Array.isArray(lastEventHeader) ? lastEventHeader[0] : lastEventHeader;

    const candidates = [
      typeof query.sinceSeqId === 'number' ? query.sinceSeqId : NaN,
      typeof lastEventIdRaw === 'string' ? Number(lastEventIdRaw) : NaN
    ].filter((value) => Number.isFinite(value) && value >= 0);

    const sinceSeqId = candidates.length > 0 ? Math.max(...candidates) : undefined;
    return this.authorityService.streamWorkflowLedger(params.workflowId, sinceSeqId);
  }
}
