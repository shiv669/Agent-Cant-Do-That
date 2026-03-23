const { Client } = require('pg');
const https = require('https');
const fs = require('fs');

function loadEnv(path) {
  const out = {};
  const lines = fs.readFileSync(path, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^(\w+)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

async function postJson(hostname, path, bodyObj) {
  const body = JSON.stringify(bodyObj);
  return await new Promise((resolve, reject) => {
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
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  const env = loadEnv('.env');
  const db = new Client({ connectionString: 'postgresql://postgres:postgres@localhost:5432/agentcantdothat' });
  await db.connect();
  const r = await db.query('select ciba_subject_token, action_scope from authority_windows order by created_at desc limit 1');
  await db.end();
  const subject = r.rows[0]?.ciba_subject_token;
  const scope = r.rows[0]?.action_scope;
  if (!subject) {
    console.log('No subject token found');
    return;
  }

  const tests = [
    ['console', env.AUTH0_CLIENT_ID, env.AUTH0_CLIENT_SECRET],
    ['tokenexchange', env.AUTH0_CUSTOM_API_CLIENT_ID, env.AUTH0_CUSTOM_API_CLIENT_SECRET],
    ['tokenvault', env.AUTH0_TOKEN_VAULT_CLIENT_ID, env.AUTH0_TOKEN_VAULT_CLIENT_SECRET],
    ['bootstrap', env.AUTH0_BOOTSTRAP_CLIENT_ID, env.AUTH0_BOOTSTRAP_CLIENT_SECRET]
  ];

  for (const [name, id, secret] of tests) {
    const res = await postJson(env.AUTH0_DOMAIN, '/oauth/token', {
      grant_type: 'urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token',
      client_id: id,
      client_secret: secret,
      subject_token: subject,
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      requested_token_type: 'http://auth0.com/oauth/token-type/federated-connection-access-token',
      connection: 'google-oauth2',
      login_hint: scope === 'execute:refund' ? env.CFO_TOKEN_VAULT_LOGIN_HINT : env.DPO_TOKEN_VAULT_LOGIN_HINT
    });
    console.log(name, id, res.status, res.body);
  }
})();
