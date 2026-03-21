#!/usr/bin/env node

import 'dotenv/config';

const required = ['AUTH0_DOMAIN'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

const bootstrapClientIdRaw = process.env.AUTH0_BOOTSTRAP_CLIENT_ID ?? '';
const bootstrapClientSecretRaw = process.env.AUTH0_BOOTSTRAP_CLIENT_SECRET ?? '';
const bootstrapClientId = bootstrapClientIdRaw.trim().replace(/^['"]|['"]$/g, '');
const bootstrapClientSecret = bootstrapClientSecretRaw.trim().replace(/^['"]|['"]$/g, '');

if (!bootstrapClientId || !bootstrapClientSecret) {
  console.log('Auth0 bootstrap credentials are empty. Skipping provisioning (manual Auth0 setup mode).');
  process.exit(0);
}

const domain = process.env.AUTH0_DOMAIN;

const audience = `https://${domain}/api/v2/`;
const apiIdentifier = 'https://agentcantdothat/api';

const scopes = [
  { value: 'orchestrate:customer_offboarding', description: 'Orchestrate customer offboarding workflow' },
  { value: 'execute:refund', description: 'Execute refund action with approved authority window' },
  { value: 'execute:data_deletion', description: 'Execute permanent data deletion action with approved authority window' }
];

const roles = [
  { name: 'operations_manager', description: 'Can initiate offboarding orchestration' },
  { name: 'cfo', description: 'Approver role for refund execution' },
  { name: 'dpo', description: 'Approver role for data deletion execution' }
];

const clients = [
  { name: 'acdt-console', app_type: 'regular_web' },
  { name: 'acdt-api', app_type: 'non_interactive' },
  { name: 'acdt-worker', app_type: 'non_interactive' }
];

async function getManagementToken() {
  const response = await fetch(`https://${domain}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: bootstrapClientId,
      client_secret: bootstrapClientSecret,
      audience
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to get management token: ${response.status} ${body}`);
  }

  const body = await response.json();
  return body.access_token;
}

async function mgmt(token, path, options = {}) {
  const response = await fetch(`https://${domain}/api/v2${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {})
    }
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(`Management API ${options.method ?? 'GET'} ${path} failed (${response.status}): ${text}`);
  }

  return data;
}

async function ensureResourceServer(token) {
  const existing = await mgmt(token, `/resource-servers?identifier=${encodeURIComponent(apiIdentifier)}`);

  if (Array.isArray(existing) && existing.length > 0) {
    const current = existing[0];
    const updatedScopesMap = new Map((current.scopes ?? []).map((s) => [s.value, s.description]));
    for (const scope of scopes) updatedScopesMap.set(scope.value, scope.description);

    const updatedScopes = [...updatedScopesMap.entries()].map(([value, description]) => ({ value, description }));

    await mgmt(token, `/resource-servers/${current.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: current.name ?? 'Agent Cant Do That API',
        token_lifetime: 120,
        enforce_policies: true,
        skip_consent_for_verifiable_first_party_clients: true,
        scopes: updatedScopes
      })
    });

    console.log(`✓ Updated resource server: ${apiIdentifier}`);
    return current.id;
  }

  const created = await mgmt(token, '/resource-servers', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Agent Cant Do That API',
      identifier: apiIdentifier,
      token_lifetime: 120,
      enforce_policies: true,
      skip_consent_for_verifiable_first_party_clients: true,
      signing_alg: 'RS256',
      scopes
    })
  });

  console.log(`✓ Created resource server: ${apiIdentifier}`);
  return created.id;
}

async function ensureRoles(token) {
  const existing = await mgmt(token, '/roles');
  const byName = new Map((existing ?? []).map((r) => [r.name, r]));

  for (const role of roles) {
    if (byName.has(role.name)) {
      console.log(`✓ Role exists: ${role.name}`);
      continue;
    }

    await mgmt(token, '/roles', {
      method: 'POST',
      body: JSON.stringify(role)
    });

    console.log(`✓ Created role: ${role.name}`);
  }
}

async function ensureClients(token) {
  const existing = await mgmt(token, '/clients');
  const byName = new Map((existing ?? []).map((c) => [c.name, c]));

  for (const client of clients) {
    if (byName.has(client.name)) {
      console.log(`✓ Client exists: ${client.name}`);
      continue;
    }

    await mgmt(token, '/clients', {
      method: 'POST',
      body: JSON.stringify(client)
    });

    console.log(`✓ Created client: ${client.name}`);
  }
}

async function main() {
  try {
    console.log('Provisioning Auth0 resources...');
    const token = await getManagementToken();

    await ensureResourceServer(token);
    await ensureRoles(token);
    await ensureClients(token);

    console.log('✓ Auth0 provisioning complete');
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

main();
