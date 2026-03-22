import { Injectable } from '@nestjs/common';
import type { ActionScope } from '@contracts/index';

type AuthzDecision = {
  allowed: boolean;
  upstreamStatus: number;
  reason: string;
};

type MintedToken = {
  accessToken: string;
  expiresIn: number;
};

@Injectable()
export class Auth0AuthorityService {
  private getTokenClientConfig() {
    const domain = process.env.AUTH0_DOMAIN;
    const audience = process.env.AUTH0_AUDIENCE;
    const clientId = process.env.AUTH0_CUSTOM_API_CLIENT_ID;
    const clientSecret = process.env.AUTH0_CUSTOM_API_CLIENT_SECRET;

    return { domain, audience, clientId, clientSecret };
  }

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

  async mintExecutionToken(actionScope: Extract<ActionScope, 'execute:refund' | 'execute:data_deletion'>): Promise<MintedToken> {
    const { domain, audience, clientId, clientSecret } = this.getTokenClientConfig();

    if (!domain || !audience || !clientId || !clientSecret) {
      throw new Error('Missing Auth0 token mint configuration');
    }

    const response = await fetch(`https://${domain}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        audience,
        scope: actionScope
      })
    });

    const body = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };

    if (!response.ok || !body.access_token || !body.expires_in) {
      throw new Error(body.error_description ?? body.error ?? 'Auth0 failed to mint execution token');
    }

    return {
      accessToken: body.access_token,
      expiresIn: body.expires_in
    };
  }

  async revokeExecutionToken(token: string): Promise<void> {
    const { domain, clientId, clientSecret } = this.getTokenClientConfig();

    if (!domain || !clientId || !clientSecret) {
      throw new Error('Missing Auth0 token revoke configuration');
    }

    const response = await fetch(`https://${domain}/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        token
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || 'Auth0 token revoke request failed');
    }
  }
}
