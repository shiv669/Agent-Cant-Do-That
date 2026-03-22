import { Body, Controller, Post } from '@nestjs/common';
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
  async requestAuthorityWindow(@Body() body: AuthorityWindowRequestInput) {
    return this.authorityService.requestAuthorityWindow(body);
  }

  @Post('window/claim')
  async claimAuthorityWindow(@Body() body: AuthorityWindowClaimInput) {
    return this.authorityService.claimAuthorityWindow(body);
  }

  @Post('window/consume')
  async consumeAuthorityWindow(@Body() body: AuthorityWindowConsumeInput) {
    return this.authorityService.consumeAuthorityWindow(body);
  }

  @Post('window/replay-attempt')
  async replayAttempt(@Body() body: AuthorityWindowReplayAttemptInput) {
    return this.authorityService.replayAttempt(body);
  }
}
