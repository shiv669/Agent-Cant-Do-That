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

type ProviderToken = {
  accessToken: string;
  expiresIn: number;
  scope?: string;
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
      subjectTokenType: 'urn:ietf:params:oauth:token-type:access_token';
    }
  | { status: 'denied'; reason: string }
  | { status: 'timeout'; reason: string };

type CibaScope = Extract<ActionScope, 'execute:refund' | 'execute:data_deletion'> | 'openid';

@Injectable()
export class Auth0AuthorityService {
  private getCibaClientConfig() {
    const domain = process.env.AUTH0_DOMAIN;
    const audience = process.env.AUTH0_CIBA_AUDIENCE ?? process.env.AUTH0_AUDIENCE;
    const clientId = process.env.AUTH0_CIBA_CLIENT_ID ?? process.env.AUTH0_CUSTOM_API_CLIENT_ID;
    const clientSecret = process.env.AUTH0_CIBA_CLIENT_SECRET ?? process.env.AUTH0_CUSTOM_API_CLIENT_SECRET;

    return { domain, audience, clientId, clientSecret };
  }

  private getTokenVaultClientConfig() {
    const domain = process.env.AUTH0_DOMAIN;
    const audience = process.env.AUTH0_AUDIENCE;
    const clientId = process.env.AUTH0_TOKEN_VAULT_CLIENT_ID ?? process.env.AUTH0_CUSTOM_API_CLIENT_ID;
    const clientSecret =
      process.env.AUTH0_TOKEN_VAULT_CLIENT_SECRET ?? process.env.AUTH0_CUSTOM_API_CLIENT_SECRET;

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
      const payload = await this.readJson<{ sub?: string; scope?: string }>(response);
      if (!payload.sub) {
        return {
          allowed: false,
          upstreamStatus: 403,
          reason: 'Auth0 userinfo response missing sub claim'
        };
      }

      const scopes = this.collectScopes(payload.scope, bearer);
      if (!scopes.has(actionScope)) {
        return {
          allowed: false,
          upstreamStatus: 403,
          reason: `Authority token missing required scope ${actionScope}`
        };
      }

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
    subjectToken: string,
    subjectTokenType: 'urn:ietf:params:oauth:token-type:access_token'
  ): Promise<MintedToken> {
    const { domain, clientId, clientSecret } = this.getTokenVaultClientConfig();
    const connection = process.env.AUTH0_CONNECTION_NAME ?? 'google-oauth2';
    const exchangeGrantType = 'urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token';
    const requestedTokenTypeFromEnv = process.env.AUTH0_TOKEN_VAULT_REQUESTED_TOKEN_TYPE?.trim();
    const defaultRequestedTokenType = 'http://auth0.com/oauth/token-type/federated-connection-access-token';
    const allowedRequestedTokenTypes = new Set([
      'http://auth0.com/oauth/token-type/federated-connection-access-token',
      'http://auth0.com/oauth/token-type/token-vault-access-token',
      'http://auth0.com/oauth/token-type/token-vault-refresh-token'
    ]);
    const requestedTokenType =
      requestedTokenTypeFromEnv && allowedRequestedTokenTypes.has(requestedTokenTypeFromEnv)
        ? requestedTokenTypeFromEnv
        : defaultRequestedTokenType;

    if (!domain || !clientId || !clientSecret) {
      throw new Error('Missing Auth0 token mint configuration');
    }

    if (!subjectToken) {
      throw new Error('Missing CIBA subject token');
    }

    const loginHint =
      actionScope === 'execute:refund'
        ? process.env.CFO_TOKEN_VAULT_LOGIN_HINT
        : process.env.DPO_TOKEN_VAULT_LOGIN_HINT;

    const body: Record<string, string> = {
      grant_type: exchangeGrantType,
      client_id: clientId,
      client_secret: clientSecret,
      subject_token: subjectToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      requested_token_type: requestedTokenType,
      connection
    };

    const normalizedLoginHint = loginHint?.trim();
    if (normalizedLoginHint) {
      body.login_hint = normalizedLoginHint;
    }

    const exchangeResponse = await fetch(`https://${domain}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const exchangeBody = (await this.readJson<{
      access_token?: string;
      expires_in?: number;
      scope?: string;
      error?: string;
      error_description?: string;
    }>(exchangeResponse));

    if (!exchangeResponse.ok || !exchangeBody.access_token || !exchangeBody.expires_in) {
      const detail = exchangeBody.error_description ?? exchangeBody.error ?? 'Token Vault exchange failed';
      throw new Error(
        `Authority token mint failed (${exchangeResponse.status}): ${detail}` +
          ` [client_id=${clientId}]` +
          ` [grant_type=${exchangeGrantType}]` +
          ` [subject_token_type=${subjectTokenType}]` +
          (normalizedLoginHint ? ` [login_hint=${normalizedLoginHint}]` : '')
      );
    }

    const response = await fetch(`https://${domain}/userinfo`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${exchangeBody.access_token}`
      }
    });

    if (!response.ok) {
      const text = await response.text();
      if (response.status === 401) {
        throw new Error('Authority token validation failed: token expired or invalid');
      }
      throw new Error(`Authority token validation failed (${response.status}): ${text || 'userinfo check failed'}`);
    }

    const payload = (await this.readJson<{ sub?: string; scope?: string }>(response));
    if (!payload.sub) {
      throw new Error(`Authority token validation failed: userinfo response missing sub for ${actionScope}`);
    }

    const scopes = this.collectScopes(payload.scope ?? exchangeBody.scope, exchangeBody.access_token);
    if (!scopes.has(actionScope)) {
      throw new Error(`Authority token validation failed: missing required scope ${actionScope}`);
    }

    console.log('Authority token validated via Auth0 userinfo');

    return {
      accessToken: exchangeBody.access_token,
      expiresIn: exchangeBody.expires_in
    };
  }

  async mintProviderAccessToken(input: {
    subjectToken: string;
    subjectTokenType?: 'urn:ietf:params:oauth:token-type:access_token' | 'urn:ietf:params:oauth:token-type:refresh_token';
    connection?: string;
    requestedTokenType?:
      | 'http://auth0.com/oauth/token-type/federated-connection-access-token'
      | 'http://auth0.com/oauth/token-type/token-vault-access-token';
    loginHint?: string;
  }): Promise<ProviderToken> {
    const { domain, clientId, clientSecret } = this.getTokenVaultClientConfig();
    const connection = input.connection ?? process.env.AUTH0_CONNECTION_NAME ?? 'google-oauth2';

    if (!domain || !clientId || !clientSecret) {
      throw new Error('Missing Auth0 token mint configuration');
    }

    if (!input.subjectToken) {
      throw new Error('Missing subject token for provider token mint');
    }

    const body: Record<string, string> = {
      grant_type: 'urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token',
      client_id: clientId,
      client_secret: clientSecret,
      subject_token: input.subjectToken,
      subject_token_type: input.subjectTokenType ?? 'urn:ietf:params:oauth:token-type:access_token',
      requested_token_type:
        input.requestedTokenType ?? 'http://auth0.com/oauth/token-type/federated-connection-access-token',
      connection
    };

    const normalizedLoginHint = input.loginHint?.trim();
    if (normalizedLoginHint) {
      body.login_hint = normalizedLoginHint;
    }

    const response = await fetch(`https://${domain}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const payload = await this.readJson<{
      access_token?: string;
      expires_in?: number;
      scope?: string;
      error?: string;
      error_description?: string;
    }>(response);

    if (!response.ok || !payload.access_token || !payload.expires_in) {
      const detail = payload.error_description ?? payload.error ?? 'Token Vault exchange failed';
      throw new Error(
        `Provider token mint failed (${response.status}): ${detail}` +
          ` [client_id=${clientId}]` +
          ` [connection=${connection}]` +
          (normalizedLoginHint ? ` [login_hint=${normalizedLoginHint}]` : '')
      );
    }

    return {
      accessToken: payload.access_token,
      expiresIn: payload.expires_in,
      scope: payload.scope
    };
  }

  async revokeExecutionToken(token: string): Promise<void> {
    const { domain, clientId, clientSecret } = this.getTokenVaultClientConfig();

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
    actionScope: CibaScope;
    approverUserId: string;
    bindingMessage: string;
  }): Promise<CibaAuthorizeResponse> {
    const { domain, audience, clientId, clientSecret } = this.getCibaClientConfig();
    if (!domain || !clientId || !clientSecret) {
      throw new Error('Missing Auth0 CIBA configuration');
    }

    const bodyParams: Record<string, string> = {
      client_id: clientId,
      client_secret: clientSecret,
      scope: `openid ${input.actionScope}`,
      login_hint: JSON.stringify({
        format: 'iss_sub',
        iss: `https://${domain}/`,
        sub: input.approverUserId
      }),
      binding_message: input.bindingMessage
    };

    const normalizedAudience = audience?.trim();
    if (normalizedAudience) {
      bodyParams.audience = normalizedAudience;
    }

    const body = new URLSearchParams(bodyParams);

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

  async getUserSubjectTokenViaCiba(input: {
    userId: string;
    bindingMessage: string;
    scope?: CibaScope;
  }): Promise<{ subjectToken: string; subjectTokenType: 'urn:ietf:params:oauth:token-type:access_token' }> {
    const cibaRequest = await this.requestCibaApproval({
      actionScope: input.scope ?? 'openid',
      approverUserId: input.userId,
      bindingMessage: input.bindingMessage
    });

    const cibaResult = await this.pollCibaApproval({
      authReqId: cibaRequest.authReqId,
      intervalSeconds: cibaRequest.interval,
      maxWaitSeconds: cibaRequest.expiresIn
    });

    if (cibaResult.status !== 'approved') {
      throw new Error(cibaResult.reason);
    }

    return {
      subjectToken: cibaResult.subjectToken,
      subjectTokenType: cibaResult.subjectTokenType
    };
  }

  async pollCibaApproval(input: {
    authReqId: string;
    intervalSeconds: number;
    maxWaitSeconds?: number;
  }): Promise<CibaPollResult> {
    const { domain, clientId, clientSecret } = this.getCibaClientConfig();
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
            subjectToken: payload.access_token,
            subjectTokenType: 'urn:ietf:params:oauth:token-type:access_token'
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

  private collectScopes(scopeValue: string | undefined, token: string): Set<string> {
    const scopes = new Set<string>();

    if (typeof scopeValue === 'string') {
      for (const scope of scopeValue.split(' ')) {
        const normalized = scope.trim();
        if (normalized) scopes.add(normalized);
      }
    }

    const jwtScopes = this.extractScopesFromJwt(token);
    for (const scope of jwtScopes) {
      scopes.add(scope);
    }

    return scopes;
  }

  private extractScopesFromJwt(token: string): Set<string> {
    const segments = token.split('.');
    if (segments.length !== 3) {
      return new Set();
    }

    try {
      const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8')) as {
        scope?: string;
        scp?: string[];
      };

      const scopes = new Set<string>();
      if (typeof payload.scope === 'string') {
        for (const scope of payload.scope.split(' ')) {
          const normalized = scope.trim();
          if (normalized) scopes.add(normalized);
        }
      }

      if (Array.isArray(payload.scp)) {
        for (const scope of payload.scp) {
          const normalized = typeof scope === 'string' ? scope.trim() : '';
          if (normalized) scopes.add(normalized);
        }
      }

      return scopes;
    } catch {
      return new Set();
    }
  }
}
