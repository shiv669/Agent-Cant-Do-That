import { ForbiddenException, Injectable } from '@nestjs/common';
import type {
  AuthorityCheckResponse,
  EscalationAttemptInput,
  HighRiskAuthorityCheckInput
} from '@contracts/index';
import { Auth0AuthorityService } from './auth0-authority.service';
import { LedgerRepository } from './ledger.repository';

@Injectable()
export class AuthorityService {
  constructor(
    private readonly auth0AuthorityService: Auth0AuthorityService,
    private readonly ledgerRepository: LedgerRepository
  ) {}

  async checkHighRiskAction(input: HighRiskAuthorityCheckInput): Promise<AuthorityCheckResponse> {
    const decision = await this.auth0AuthorityService.checkExecutionAuthority(input.actionScope, input.authorityWindowToken);

    if (!decision.allowed) {
      await this.ledgerRepository.appendEvent({
        workflowId: input.workflowId,
        eventType: 'high_risk_action_blocked',
        payload: {
          actionScope: input.actionScope,
          reason: decision.reason,
          upstreamStatus: decision.upstreamStatus
        }
      });

      throw new ForbiddenException({
        workflowId: input.workflowId,
        actionScope: input.actionScope,
        authority: 'denied',
        reason: decision.reason
      });
    }

    return {
      workflowId: input.workflowId,
      actionScope: input.actionScope,
      authority: 'granted'
    };
  }

  async recordEscalationAttempt(input: EscalationAttemptInput): Promise<AuthorityCheckResponse> {
    const decision = await this.auth0AuthorityService.checkExecutionAuthority(input.actionScope, input.authorityWindowToken);

    if (!decision.allowed) {
      await this.ledgerRepository.appendEvent({
        workflowId: input.workflowId,
        eventType: 'unauthorized_escalation_attempt_recorded',
        payload: {
          actionScope: input.actionScope,
          reason: input.reason ?? 'Escalation requested without valid authority window',
          upstreamStatus: decision.upstreamStatus,
          upstreamDetail: decision.reason
        }
      });

      throw new ForbiddenException({
        workflowId: input.workflowId,
        actionScope: input.actionScope,
        authority: 'denied'
      });
    }

    return {
      workflowId: input.workflowId,
      actionScope: input.actionScope,
      authority: 'granted'
    };
  }
}
