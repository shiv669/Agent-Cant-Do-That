const fs = require('fs');
const https = require('https');

function loadEnv() {
  const out = {};
  for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^(\w+)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function postForm(host, path, formObj) {
  const body = new URLSearchParams(formObj).toString();
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data || '{}'); } catch {}
        resolve({ status: res.statusCode || 0, body: data, json: parsed });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function postJson(host, path, obj, bearer) {
  const body = JSON.stringify(obj);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {})
      }
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data || '{}'); } catch {}
        resolve({ status: res.statusCode || 0, body: data, json: parsed });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  const env = loadEnv();
  const host = env.AUTH0_DOMAIN;
  const cibaClientId = env.AUTH0_CLIENT_ID;
  const cibaClientSecret = env.AUTH0_CLIENT_SECRET;
  const cfoUserId = env.CFO_USER_ID;
  const myAccountAud = `https://${host}/me/`;
  const scope = 'openid profile offline_access create:me:connected_accounts read:me:connected_accounts delete:me:connected_accounts';

  const authorize = await postForm(host, '/bc-authorize', {
    client_id: cibaClientId,
    client_secret: cibaClientSecret,
    scope,
    audience: myAccountAud,
    login_hint: JSON.stringify({ format: 'iss_sub', iss: `https://${host}/`, sub: cfoUserId }),
    binding_message: 'Connect CFO google account to token vault'
  });

  if (authorize.status < 200 || authorize.status >= 300 || !authorize.json?.auth_req_id) {
    console.log('CIBA_AUTHORIZE_FAILED', authorize.status, authorize.body);
    process.exit(1);
  }

  const authReqId = authorize.json.auth_req_id;
  const interval = Number(authorize.json.interval || 2);
  const expiresIn = Number(authorize.json.expires_in || 120);
  const deadline = Date.now() + expiresIn * 1000;

  let cfoToken = null;
  while (Date.now() < deadline) {
    const poll = await postForm(host, '/oauth/token', {
      grant_type: 'urn:openid:params:grant-type:ciba',
      auth_req_id: authReqId,
      client_id: cibaClientId,
      client_secret: cibaClientSecret
    });

    if (poll.status >= 200 && poll.status < 300 && poll.json?.access_token) {
      cfoToken = poll.json.access_token;
      break;
    }

    const err = poll.json?.error || '';
    if (err === 'authorization_pending' || err === 'slow_down') {
      const sleepMs = (err === 'slow_down' ? interval + 2 : interval) * 1000;
      await new Promise((r) => setTimeout(r, sleepMs));
      continue;
    }

    console.log('CIBA_POLL_FAILED', poll.status, poll.body);
    process.exit(1);
  }

  if (!cfoToken) {
    console.log('CIBA_TIMEOUT_NO_TOKEN');
    process.exit(1);
  }

  const connect = await postJson(host, '/me/v1/connected-accounts/connect', {
    connection: 'google-oauth2',
    redirect_uri: 'http://localhost:3000',
    state: 'cfo-token-vault-connect',
    scopes: ['openid', 'profile', 'email']
  }, cfoToken);

  if (connect.status < 200 || connect.status >= 300) {
    console.log('CONNECT_INIT_FAILED', connect.status, connect.body);
    process.exit(1);
  }

  const authSession = connect.json?.auth_session;
  const connectUri = connect.json?.connect_uri;
  const ticket = connect.json?.connect_params?.ticket;

  if (!authSession || !connectUri || !ticket) {
    console.log('CONNECT_INIT_INCOMPLETE', JSON.stringify(connect.json));
    process.exit(1);
  }

  const fullConnectUrl = `${connectUri}?ticket=${encodeURIComponent(ticket)}`;
  fs.writeFileSync('cfo-connect-session.json', JSON.stringify({ auth_session: authSession, redirect_uri: 'http://localhost:3000', connect_url: fullConnectUrl }, null, 2));
  console.log('CONNECT_READY_URL', fullConnectUrl);
  console.log('SESSION_FILE', 'cfo-connect-session.json');
})();
