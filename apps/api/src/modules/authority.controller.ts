import { Body, Controller, Get, Param, Post } from '@nestjs/common';
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

  @Post('high-risk/check')
  async checkHighRiskAction(@Body() body: HighRiskAuthorityCheckInput) {
    return this.authorityService.checkHighRiskAction(body);
  }

  @Post('escalate')
  async escalate(@Body() body: EscalationAttemptInput) {
    return this.authorityService.recordEscalationAttempt(body);
  }

  @Post('window/request')
  async requestAuthorityWindow(@Body() body: AuthorityWindowRequestInput & { agentId?: string; scope?: string }) {
    const normalized: AuthorityWindowRequestInput = {
      workflowId: body.workflowId,
      customerId: body.customerId,
      actionScope: (body.actionScope ?? body.scope) as AuthorityWindowRequestInput['actionScope'],
      requestingAgentClientId: body.requestingAgentClientId ?? body.agentId ?? 'orchestrator-a',
      boundAgentClientId: body.boundAgentClientId ?? body.agentId ?? 'subagent-d-client',
      amount: body.amount,
      ttlSeconds: body.ttlSeconds
    };

    return this.authorityService.requestAuthorityWindow(normalized);
  }

  @Post('window/claim')
  async claimAuthorityWindow(@Body() body: AuthorityWindowClaimInput & { agentId?: string }) {
    const normalized: AuthorityWindowClaimInput = {
      windowId: body.windowId,
      claimantAgentClientId: body.claimantAgentClientId ?? body.agentId ?? ''
    };
    return this.authorityService.claimAuthorityWindow(normalized);
  }

  @Post('window/consume')
  async consumeAuthorityWindow(@Body() body: AuthorityWindowConsumeInput & { agentId?: string }) {
    const normalized: AuthorityWindowConsumeInput = {
      windowId: body.windowId,
      claimantAgentClientId: body.claimantAgentClientId ?? body.agentId ?? ''
    };
    return this.authorityService.consumeAuthorityWindow(normalized);
  }

  @Post('window/replay-attempt')
  async replayAttempt(@Body() body: AuthorityWindowReplayAttemptInput & { agentId?: string }) {
    const normalized: AuthorityWindowReplayAttemptInput = {
      windowId: body.windowId,
      claimantAgentClientId: body.claimantAgentClientId ?? body.agentId ?? ''
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
