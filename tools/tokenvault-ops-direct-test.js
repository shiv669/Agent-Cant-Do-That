#!/usr/bin/env node

const fs = require('node:fs');
const https = require('node:https');

function loadEnv() {
  const out = {};
  for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const match = line.match(/^(\w+)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    out[match[1]] = value;
  }
  return out;
}

function postJson(hostname, path, bodyObj) {
  const body = JSON.stringify(bodyObj);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(data || '{}');
          } catch {
            parsed = { raw: data };
          }
          resolve({ status: res.statusCode || 0, json: parsed, raw: data });
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function getJson(hostname, path, bearer) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        path,
        method: 'GET',
        headers: bearer ? { Authorization: `Bearer ${bearer}` } : {}
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(data || '{}');
          } catch {
            parsed = { raw: data };
          }
          resolve({ status: res.statusCode || 0, json: parsed, raw: data });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const env = loadEnv();
  const domain = env.AUTH0_DOMAIN;
  const opsEmail = env.OPS_MANAGER_EMAIL || 'ops@agentcantdothat.dev';
  const opsPassword = env.OPS_MANAGER_PASSWORD;
  const passwordRealm = env.AUTH0_PASSWORD_REALM || 'Username-Password-Authentication';

  if (!opsPassword) {
    console.error('Missing OPS_MANAGER_PASSWORD in .env');
    process.exit(1);
  }

  const login = await postJson(domain, '/oauth/token', {
    grant_type: 'http://auth0.com/oauth/grant-type/password-realm',
    client_id: env.AUTH0_CLIENT_ID,
    client_secret: env.AUTH0_CLIENT_SECRET,
    username: opsEmail,
    password: opsPassword,
    realm: passwordRealm,
    scope: 'openid profile email offline_access',
    audience: env.AUTH0_AUDIENCE
  });

  if (login.status < 200 || login.status >= 300 || !login.json.access_token) {
    console.error('OPS_LOGIN_FAILED', login.status, login.raw);
    process.exit(1);
  }

  const opsAccessToken = login.json.access_token;
  console.log('[Ops] Access token acquired');

  let loginHint = env.OPS_TOKEN_VAULT_LOGIN_HINT;
  if (!loginHint && env.OPS_USER_ID) {
    const mgmt = await postJson(domain, '/oauth/token', {
      grant_type: 'client_credentials',
      client_id: env.AUTH0_TOKEN_VAULT_CLIENT_ID,
      client_secret: env.AUTH0_TOKEN_VAULT_CLIENT_SECRET,
      audience: `https://${domain}/api/v2/`
    });

    if (mgmt.status >= 200 && mgmt.status < 300 && mgmt.json.access_token) {
      const user = await getJson(
        domain,
        `/api/v2/users/${encodeURIComponent(env.OPS_USER_ID)}`,
        mgmt.json.access_token
      );
      const identities = Array.isArray(user.json?.identities) ? user.json.identities : [];
      const google = identities.find((item) => item.provider === 'google-oauth2');
      if (google?.user_id) {
        loginHint = `google-oauth2|${google.user_id}`;
      }
    }
  }

  const exchangePayload = {
    grant_type: 'urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token',
    client_id: env.AUTH0_TOKEN_VAULT_CLIENT_ID,
    client_secret: env.AUTH0_TOKEN_VAULT_CLIENT_SECRET,
    subject_token: opsAccessToken,
    subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    requested_token_type: 'http://auth0.com/oauth/token-type/federated-connection-access-token',
    connection: env.AUTH0_CONNECTION_NAME || 'google-oauth2'
  };
  if (loginHint) exchangePayload.login_hint = loginHint;

  const exchange = await postJson(domain, '/oauth/token', exchangePayload);
  if (exchange.status < 200 || exchange.status >= 300 || !exchange.json.access_token) {
    console.error('[Token Vault] Exchange failed', exchange.status, exchange.raw);
    process.exit(1);
  }

  console.log('[Token Vault] Exchange succeeded for ops user');
  const googleAccessToken = exchange.json.access_token;

  // Sheets API requires Bearer token; perform with explicit header request.
  const body = JSON.stringify({
    properties: { title: `Ops Export ${new Date().toISOString()}` },
    sheets: [{ properties: { title: 'BillingHistory' } }]
  });
  const sheetResponse = await new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'sheets.googleapis.com',
        path: '/v4/spreadsheets',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${googleAccessToken}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(data || '{}');
          } catch {
            parsed = { raw: data };
          }
          resolve({ status: res.statusCode || 0, json: parsed, raw: data });
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  if (sheetResponse.status < 200 || sheetResponse.status >= 300) {
    console.error('[Google Sheets] Create failed', sheetResponse.status, sheetResponse.raw);
    process.exit(1);
  }

  const sheetUrl =
    sheetResponse.json.spreadsheetUrl ||
    (sheetResponse.json.spreadsheetId
      ? `https://docs.google.com/spreadsheets/d/${sheetResponse.json.spreadsheetId}`
      : 'unknown');

  console.log('[Google Sheets] Sheet created:', sheetUrl);
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
