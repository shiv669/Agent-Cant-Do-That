import { Injectable } from '@nestjs/common';
import type { ActionScope } from '@contracts/index';

type AuthzDecision = {
  allowed: boolean;
  upstreamStatus: number;
  reason: string;
};

@Injectable()
export class Auth0AuthorityService {
  async checkExecutionAuthority(
    actionScope: Extract<ActionScope, 'execute:refund' | 'execute:data_deletion'>,
    authorityWindowToken?: string
  ): Promise<AuthzDecision> {
    const domain = process.env.AUTH0_DOMAIN;

    if (!domain) {
      return {
        allowed: false,
        upstreamStatus: 403,
        reason: 'Auth0 configuration is incomplete for authority validation'
      };
    }

    const bearer = authorityWindowToken?.trim() ?? '';
    const response = await fetch(`https://${domain}/userinfo`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${bearer}`
      }
    });

    if (response.ok) {
      return {
        allowed: true,
        upstreamStatus: 200,
        reason: `Authority artifact accepted by Auth0 for ${actionScope}`
      };
    }

    const text = await response.text();
    let details = text;
    try {
      const parsed = JSON.parse(text) as { error?: string; error_description?: string };
      details = parsed.error_description ?? parsed.error ?? text;
    } catch {
      // Keep raw response text when body is not JSON.
    }

    return {
      allowed: false,
      upstreamStatus: response.status,
      reason: details || 'Auth0 denied execution authority artifact'
    };
  }
}
