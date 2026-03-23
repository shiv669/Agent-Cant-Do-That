import { Body, Controller, ForbiddenException, Get, Param, Post, Req } from '@nestjs/common';
import type {
  AuthorityWindowClaimInput,
  AuthorityWindowConsumeInput,
  AuthorityWindowReplayAttemptInput,
  AuthorityWindowRequestInput,
  EscalationAttemptInput,
  HighRiskAuthorityCheckInput
} from '@contracts/index';
import { AuthorityService } from './authority.service';

@Controller('authority')
export class AuthorityController {
  constructor(private readonly authorityService: AuthorityService) {}

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
  async checkHighRiskAction(@Body() body: HighRiskAuthorityCheckInput, @Req() req: { headers: Record<string, string | string[] | undefined> }) {
    this.getAgentClientId(req);
    return this.authorityService.checkHighRiskAction(body);
  }

  @Post('escalate')
  async escalate(@Body() body: EscalationAttemptInput, @Req() req: { headers: Record<string, string | string[] | undefined> }) {
    this.getAgentClientId(req);
    return this.authorityService.recordEscalationAttempt(body);
  }

  @Post('window/request')
  async requestAuthorityWindow(
    @Body() body: AuthorityWindowRequestInput & { agentId?: string; scope?: string },
    @Req() req: { headers: Record<string, string | string[] | undefined> }
  ) {
    const agentClientId = this.getAgentClientId(req);

    const normalized: AuthorityWindowRequestInput = {
      workflowId: body.workflowId,
      customerId: body.customerId,
      actionScope: (body.actionScope ?? body.scope) as AuthorityWindowRequestInput['actionScope'],
      requestingAgentClientId: agentClientId,
      boundAgentClientId: body.boundAgentClientId ?? body.agentId ?? 'subagent-d-client',
      amount: body.amount,
      ttlSeconds: body.ttlSeconds
    };

    return this.authorityService.requestAuthorityWindow(normalized);
  }

  @Post('window/claim')
  async claimAuthorityWindow(
    @Body() body: AuthorityWindowClaimInput & { agentId?: string },
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
    @Body() body: AuthorityWindowConsumeInput & { agentId?: string },
    @Req() req: { headers: Record<string, string | string[] | undefined> }
  ) {
    const agentClientId = this.getAgentClientId(req);
    const normalized: AuthorityWindowConsumeInput = {
      windowId: body.windowId,
      claimantAgentClientId: agentClientId
    };
    return this.authorityService.consumeAuthorityWindow(normalized);
  }

  @Post('window/replay-attempt')
  async replayAttempt(
    @Body() body: AuthorityWindowReplayAttemptInput & { agentId?: string },
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
  async getWindow(@Param('windowId') windowId: string) {
    return this.authorityService.getWindow(windowId);
  }

  @Get('ledger/:workflowId')
  async getWorkflowLedger(@Param('workflowId') workflowId: string) {
    return this.authorityService.getWorkflowLedger(workflowId);
  }
}
