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

type CibaAuthorizeResponse = {
  authReqId: string;
  expiresIn: number;
  interval: number;
};

type CibaPollResult =
  | {
      status: 'approved';
      approvedAt: string;
      subjectToken: string;
    }
  | { status: 'denied'; reason: string }
  | { status: 'timeout'; reason: string };

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

  async mintExecutionToken(
    actionScope: Extract<ActionScope, 'execute:refund' | 'execute:data_deletion'>,
    cibaAccessToken: string
  ): Promise<MintedToken> {
    const { domain } = this.getTokenClientConfig();

    if (!domain) {
      throw new Error('Missing Auth0 token mint configuration');
    }

    if (!cibaAccessToken) {
      throw new Error('Missing CIBA approved access token');
    }

    const response = await fetch(`https://${domain}/userinfo`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${cibaAccessToken}`
      }
    });

    if (!response.ok) {
      const text = await response.text();
      if (response.status === 401) {
        throw new Error('Authority token validation failed: token expired or invalid');
      }
      throw new Error(`Authority token validation failed (${response.status}): ${text || 'userinfo check failed'}`);
    }

    const payload = (await response.json()) as { sub?: string };
    if (!payload.sub) {
      throw new Error(`Authority token validation failed: userinfo response missing sub for ${actionScope}`);
    }

    console.log('Authority token validated via Auth0 userinfo');

    return {
      accessToken: cibaAccessToken,
      expiresIn: 120
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

    console.log('Authority token revoked via Auth0');
  }

  async requestCibaApproval(input: {
    actionScope: Extract<ActionScope, 'execute:refund' | 'execute:data_deletion'>;
    approverUserId: string;
    bindingMessage: string;
  }): Promise<CibaAuthorizeResponse> {
    const { domain, clientId, clientSecret } = this.getTokenClientConfig();
    if (!domain || !clientId || !clientSecret) {
      throw new Error('Missing Auth0 CIBA configuration');
    }

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: `openid ${input.actionScope}`,
      login_hint: JSON.stringify({
        format: 'iss_sub',
        iss: `https://${domain}/`,
        sub: input.approverUserId
      }),
      binding_message: input.bindingMessage
    });

    const response = await fetch(`https://${domain}/bc-authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });

    const payload = await this.readJson<{ 
      auth_req_id?: string;
      expires_in?: number;
      interval?: number;
      error?: string;
      error_description?: string;
    }>(response);

    if (!response.ok || !payload.auth_req_id) {
      throw new Error(payload.error_description ?? payload.error ?? 'Auth0 CIBA authorize failed');
    }

    return {
      authReqId: payload.auth_req_id,
      expiresIn: payload.expires_in ?? 120,
      interval: payload.interval ?? 2
    };
  }

  async pollCibaApproval(input: {
    authReqId: string;
    intervalSeconds: number;
    maxWaitSeconds?: number;
  }): Promise<CibaPollResult> {
    const { domain, clientId, clientSecret } = this.getTokenClientConfig();
    if (!domain || !clientId || !clientSecret) {
      throw new Error('Missing Auth0 CIBA poll configuration');
    }

    const timeoutSeconds = input.maxWaitSeconds ?? Number(process.env.AUTH0_CIBA_TIMEOUT_SECONDS ?? 120);
    const start = Date.now();

    while ((Date.now() - start) / 1000 < timeoutSeconds) {
      const body = new URLSearchParams({
        grant_type: 'urn:openid:params:grant-type:ciba',
        auth_req_id: input.authReqId,
        client_id: clientId,
        client_secret: clientSecret
      });

      const response = await fetch(`https://${domain}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });

      const payload = await this.readJson<{
        access_token?: string;
        error?: string;
        error_description?: string;
      }>(response);

      if (response.ok) {
        if (payload.access_token) {
          return {
            status: 'approved',
            approvedAt: new Date().toISOString(),
            subjectToken: payload.access_token
          };
        }

        return {
          status: 'denied',
          reason: 'CIBA approved but no access_token was returned'
        };
      }

      const err = payload.error ?? '';
      if (err === 'authorization_pending' || err === 'slow_down') {
        const sleepMs = (err === 'slow_down' ? input.intervalSeconds + 2 : input.intervalSeconds) * 1000;
        await new Promise((resolve) => setTimeout(resolve, sleepMs));
        continue;
      }

      if (err === 'access_denied') {
        return {
          status: 'denied',
          reason: payload.error_description ?? 'Step-up denied by approver'
        };
      }

      if (err === 'expired_token') {
        return {
          status: 'timeout',
          reason: payload.error_description ?? 'Step-up request expired'
        };
      }

      return {
        status: 'denied',
        reason: payload.error_description ?? err ?? 'Step-up failed'
      };
    }

    return {
      status: 'timeout',
      reason: 'Step-up approval timed out'
    };
  }

  private async readJson<T>(response: Response): Promise<T> {
    const raw = await response.text();
    if (!raw) {
      return {} as T;
    }

    try {
      return JSON.parse(raw) as T;
    } catch {
      return { error_description: raw } as T;
    }
  }
}
