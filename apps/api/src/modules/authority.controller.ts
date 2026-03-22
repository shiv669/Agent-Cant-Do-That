import { Body, Controller, Post } from '@nestjs/common';
import type { EscalationAttemptInput, HighRiskAuthorityCheckInput } from '@contracts/index';
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
}
