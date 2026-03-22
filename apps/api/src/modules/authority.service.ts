import { ForbiddenException, Injectable, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  AuthorityWindowClaimInput,
  AuthorityWindowClaimResponse,
  AuthorityWindowConsumeInput,
  AuthorityWindowConsumeResponse,
  AuthorityWindowReplayAttemptInput,
  AuthorityWindowRequestInput,
  AuthorityWindowRequestResponse,
  AuthorityCheckResponse,
  EscalationAttemptInput,
  HighRiskAuthorityCheckInput
} from '@contracts/index';
import { Auth0AuthorityService } from './auth0-authority.service';
import { AuthorityWindowRepository } from './authority-window.repository';
import { LedgerRepository } from './ledger.repository';

@Injectable()
export class AuthorityService implements OnModuleInit {
  constructor(
    private readonly auth0AuthorityService: Auth0AuthorityService,
    private readonly authorityWindowRepository: AuthorityWindowRepository,
    private readonly ledgerRepository: LedgerRepository
  ) {}

  async onModuleInit(): Promise<void> {
    await this.authorityWindowRepository.ensureSchema();
  }

  async requestAuthorityWindow(input: AuthorityWindowRequestInput): Promise<AuthorityWindowRequestResponse> {
    if (input.actionScope === 'execute:refund' && typeof input.amount !== 'number') {
      throw new ForbiddenException({ reason: 'Refund requests must include amount for CIBA binding message' });
    }

    const approver = this.getApproverForScope(input.actionScope);
    if (!approver.userId) {
      throw new ForbiddenException({ reason: `Missing ${approver.role.toUpperCase()}_USER_ID for step-up routing` });
    }

    const bindingMessage = this.buildBindingMessage(input);

    if (input.actionScope === 'execute:data_deletion') {
      const previousRefundWindow = await this.authorityWindowRepository.findLatestConsumedWindowByWorkflowAndScope({
        workflowId: input.workflowId,
        actionScope: 'execute:refund'
      });

      await this.ledgerRepository.appendEvent({
        workflowId: input.workflowId,
        eventType: 'high_risk_action_blocked',
        payload: {
          actionScope: input.actionScope,
          reason: 'Authority window absent - execution blocked',
          previousWindowId: previousRefundWindow?.window_id ?? 'unknown'
        }
      });
    }

    await this.ledgerRepository.appendEvent({
      workflowId: input.workflowId,
      eventType: 'step_up_requested',
      payload: {
        actionScope: input.actionScope,
        approverRole: approver.role,
        approverUserId: approver.userId,
        bindingMessage
      }
    });

    let cibaRequest: { authReqId: string; interval: number; expiresIn: number };
    try {
      cibaRequest = await this.auth0AuthorityService.requestCibaApproval({
        actionScope: input.actionScope,
        approverUserId: approver.userId,
        bindingMessage
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Step-up request failed';
      await this.ledgerRepository.appendEvent({
        workflowId: input.workflowId,
        eventType: 'step_up_denied',
        payload: {
          actionScope: input.actionScope,
          approverRole: approver.role,
          approverUserId: approver.userId,
          reason
        }
      });

      throw new ForbiddenException({
        workflowId: input.workflowId,
        actionScope: input.actionScope,
        reason
      });
    }

    const cibaResult = await this.auth0AuthorityService.pollCibaApproval({
      authReqId: cibaRequest.authReqId,
      intervalSeconds: cibaRequest.interval,
      maxWaitSeconds: cibaRequest.expiresIn
    });

    if (cibaResult.status === 'denied') {
      await this.ledgerRepository.appendEvent({
        workflowId: input.workflowId,
        eventType: 'step_up_denied',
        payload: {
          actionScope: input.actionScope,
          approverRole: approver.role,
          approverUserId: approver.userId,
          reason: cibaResult.reason
        }
      });

      throw new ForbiddenException({
        workflowId: input.workflowId,
        actionScope: input.actionScope,
        reason: cibaResult.reason
      });
    }

    if (cibaResult.status === 'timeout') {
      await this.ledgerRepository.appendEvent({
        workflowId: input.workflowId,
        eventType: 'step_up_timeout',
        payload: {
          actionScope: input.actionScope,
          approverRole: approver.role,
          approverUserId: approver.userId,
          reason: cibaResult.reason
        }
      });

      throw new ForbiddenException({
        workflowId: input.workflowId,
        actionScope: input.actionScope,
        reason: cibaResult.reason
      });
    }

    await this.ledgerRepository.appendEvent({
      workflowId: input.workflowId,
      eventType: 'step_up_approved',
      payload: {
        actionScope: input.actionScope,
        approverRole: approver.role,
        approverIdentity: approver.userId,
        approvedAt: cibaResult.approvedAt
      }
    });

    const ttlSeconds = Math.min(Math.max(input.ttlSeconds ?? 120, 30), 300);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    const windowId = randomUUID();

    const window = await this.authorityWindowRepository.insertWindow({
      windowId,
      workflowId: input.workflowId,
      actionScope: input.actionScope,
      boundAgentClientId: input.boundAgentClientId,
      status: 'requested',
      expiresAt
    });

    await this.ledgerRepository.appendEvent({
      workflowId: input.workflowId,
      eventType: 'authority_window_requested',
      payload: {
        windowId,
        actionScope: input.actionScope,
        boundAgentClientId: input.boundAgentClientId,
        ttlSeconds,
        expiresAt: expiresAt.toISOString()
      }
    });

    return {
      windowId: window.window_id,
      workflowId: window.workflow_id,
      actionScope: window.action_scope,
      boundAgentClientId: window.bound_agent_client_id,
      expiresAt: new Date(window.expires_at).toISOString(),
      status: window.status
    };
  }

  async claimAuthorityWindow(input: AuthorityWindowClaimInput): Promise<AuthorityWindowClaimResponse> {
    await this.authorityWindowRepository.markExpiredWindows();
    const window = await this.authorityWindowRepository.findWindow(input.windowId);

    if (!window) {
      throw new ForbiddenException({ reason: 'Authority window does not exist' });
    }

    if (window.status === 'consumed' || window.status === 'revoked' || window.status === 'expired') {
      await this.ledgerRepository.appendEvent({
        workflowId: window.workflow_id,
        eventType: 'replay_attempt_blocked',
        payload: {
          windowId: window.window_id,
          claimantAgentClientId: input.claimantAgentClientId,
          status: window.status
        }
      });
      throw new ForbiddenException({ reason: 'Replay blocked' });
    }

    if (window.bound_agent_client_id !== input.claimantAgentClientId) {
      await this.ledgerRepository.appendEvent({
        workflowId: window.workflow_id,
        eventType: 'cross_action_propagation_denied',
        payload: {
          windowId: window.window_id,
          boundAgentClientId: window.bound_agent_client_id,
          claimantAgentClientId: input.claimantAgentClientId
        }
      });
      throw new ForbiddenException({ reason: 'Window is bound to a different agent identity' });
    }

    const minted = await this.auth0AuthorityService.mintExecutionToken(window.action_scope);
    const claimed = await this.authorityWindowRepository.markClaimed({
      windowId: window.window_id,
      claimantAgentClientId: input.claimantAgentClientId,
      authorityWindowToken: minted.accessToken
    });

    if (!claimed) {
      throw new ForbiddenException({ reason: 'Window cannot be claimed' });
    }

    await this.ledgerRepository.appendEvent({
      workflowId: claimed.workflow_id,
      eventType: 'authority_window_claimed',
      payload: {
        windowId: claimed.window_id,
        claimantAgentClientId: input.claimantAgentClientId,
        expiresAt: new Date(claimed.expires_at).toISOString(),
        tokenTtlSeconds: minted.expiresIn
      }
    });

    await this.ledgerRepository.appendEvent({
      workflowId: claimed.workflow_id,
      eventType: 'authority_window_issued',
      payload: {
        windowId: claimed.window_id,
        actionScope: claimed.action_scope,
        boundAgentClientId: claimed.bound_agent_client_id
      }
    });

    return {
      windowId: claimed.window_id,
      workflowId: claimed.workflow_id,
      actionScope: claimed.action_scope,
      claimantAgentClientId: input.claimantAgentClientId,
      status: claimed.status,
      authorityWindowToken: minted.accessToken,
      expiresAt: new Date(claimed.expires_at).toISOString()
    };
  }

  async consumeAuthorityWindow(input: AuthorityWindowConsumeInput): Promise<AuthorityWindowConsumeResponse> {
    const window = await this.authorityWindowRepository.findWindow(input.windowId);
    if (!window) {
      throw new ForbiddenException({ reason: 'Authority window does not exist' });
    }

    if (window.claimant_agent_client_id !== input.claimantAgentClientId) {
      throw new ForbiddenException({ reason: 'Claimant identity mismatch' });
    }

    if (window.status !== 'claimed' || !window.authority_window_token) {
      throw new ForbiddenException({ reason: 'Only claimed windows can be consumed' });
    }

    await this.auth0AuthorityService.revokeExecutionToken(window.authority_window_token);
    const consumed = await this.authorityWindowRepository.markConsumed(window.window_id);
    const revoked = await this.authorityWindowRepository.markRevoked(window.window_id);

    if (!consumed || !revoked) {
      throw new ForbiddenException({ reason: 'Window consume/revoke transition failed' });
    }

    await this.ledgerRepository.appendEvent({
      workflowId: consumed.workflow_id,
      eventType: 'authority_window_consumed',
      payload: {
        windowId: consumed.window_id,
        actionScope: consumed.action_scope,
        claimantAgentClientId: input.claimantAgentClientId
      }
    });

    await this.ledgerRepository.appendEvent({
      workflowId: revoked.workflow_id,
      eventType: 'authority_token_revoked',
      payload: {
        windowId: revoked.window_id,
        revokedAt: new Date(revoked.revoked_at ?? new Date()).toISOString()
      }
    });

    if (consumed.action_scope === 'execute:data_deletion') {
      const previousRefundWindow = await this.authorityWindowRepository.findLatestConsumedWindowByWorkflowAndScope({
        workflowId: consumed.workflow_id,
        actionScope: 'execute:refund'
      });

      await this.ledgerRepository.appendEvent({
        workflowId: consumed.workflow_id,
        eventType: 'cross_action_propagation_check_passed',
        payload: {
          previousWindowId: previousRefundWindow?.window_id ?? 'unknown',
          newWindowRequired: true,
          authorityCarriedForward: false
        }
      });
    }

    return {
      windowId: revoked.window_id,
      workflowId: revoked.workflow_id,
      actionScope: revoked.action_scope,
      status: revoked.status
    };
  }

  async replayAttempt(input: AuthorityWindowReplayAttemptInput): Promise<never> {
    const window = await this.authorityWindowRepository.findWindow(input.windowId);

    if (!window) {
      throw new ForbiddenException({ reason: 'Authority window does not exist' });
    }

    await this.ledgerRepository.appendEvent({
      workflowId: window.workflow_id,
      eventType: 'replay_attempt_blocked',
      payload: {
        windowId: window.window_id,
        claimantAgentClientId: input.claimantAgentClientId,
        status: window.status
      }
    });

    throw new ForbiddenException({
      windowId: window.window_id,
      workflowId: window.workflow_id,
      reason: 'Replay attempt blocked'
    });
  }

  async getWindow(windowId: string) {
    const window = await this.authorityWindowRepository.findWindow(windowId);
    if (!window) {
      throw new ForbiddenException({ reason: 'Authority window does not exist' });
    }

    return {
      windowId: window.window_id,
      workflowId: window.workflow_id,
      actionScope: window.action_scope,
      boundAgentClientId: window.bound_agent_client_id,
      claimantAgentClientId: window.claimant_agent_client_id,
      status: window.status,
      expiresAt: new Date(window.expires_at).toISOString(),
      claimedAt: window.claimed_at ? new Date(window.claimed_at).toISOString() : null,
      consumedAt: window.consumed_at ? new Date(window.consumed_at).toISOString() : null,
      revokedAt: window.revoked_at ? new Date(window.revoked_at).toISOString() : null,
      createdAt: new Date(window.created_at).toISOString()
    };
  }

  async getWorkflowLedger(workflowId: string) {
    return this.ledgerRepository.listByWorkflowId(workflowId);
  }

  async checkHighRiskAction(input: HighRiskAuthorityCheckInput): Promise<AuthorityCheckResponse> {
    const decision = await this.auth0AuthorityService.checkExecutionAuthority(input.actionScope, input.authorityWindowToken);

    if (!decision.allowed) {
      await this.ledgerRepository.appendEvent({
        workflowId: input.workflowId,
        eventType: 'high_risk_action_blocked',
        payload: {
          actionScope: input.actionScope,
          reason: 'Authority window absent - execution blocked',
          upstreamReason: decision.reason,
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

  private getApproverForScope(scope: AuthorityWindowRequestInput['actionScope']): { role: 'cfo' | 'dpo'; userId: string } {
    if (scope === 'execute:refund') {
      return {
        role: 'cfo',
        userId: process.env.CFO_USER_ID ?? ''
      };
    }

    return {
      role: 'dpo',
      userId: process.env.DPO_USER_ID ?? ''
    };
  }

  private buildBindingMessage(input: AuthorityWindowRequestInput): string {
    const actionPart = input.actionScope === 'execute:refund' ? 'refund' : 'data_deletion';
    const valuePart = input.actionScope === 'execute:refund' ? `amt:${input.amount}` : `scp:${input.actionScope}`;
    const requester = input.requestingAgentClientId.length > 12
      ? input.requestingAgentClientId.slice(0, 12)
      : input.requestingAgentClientId;

    const bindingMessage = `cid:${input.customerId} act:${actionPart} ${valuePart} req:${requester}`;
    return bindingMessage.length > 64 ? bindingMessage.slice(0, 64) : bindingMessage;
  }
}
