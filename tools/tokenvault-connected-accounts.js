#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const ROOT = process.cwd();
const ENV_PATH = path.join(ROOT, '.env');
const STATE_DIR = path.join(ROOT, '.tokenvault-state');
const DEFAULT_CONNECTED_ACCOUNTS_REDIRECT_URI = 'http://localhost:9876/callback';

function loadEnv() {
	const out = {};
	const lines = fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/);
	for (const line of lines) {
		const m = line.match(/^(\w+)=(.*)$/);
		if (!m) continue;
		let v = m[2].trim();
		if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1);
		out[m[1]] = v;
	}
	return out;
}

function requestJson(hostname, method, urlPath, bodyObj, bearerToken) {
	const body = bodyObj ? JSON.stringify(bodyObj) : '';
	return new Promise((resolve, reject) => {
		const req = https.request(
			{
				hostname,
				path: urlPath,
				method,
				headers: {
					'Content-Type': 'application/json',
					...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
					...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {})
				}
			},
			(res) => {
				let data = '';
				res.on('data', (c) => (data += c));
				res.on('end', () => {
					let json = null;
					try {
						json = JSON.parse(data || '{}');
					} catch {
						json = null;
					}
					resolve({ status: res.statusCode || 0, body: data, json });
				});
			}
		);

		req.on('error', reject);
		if (body) req.write(body);
		req.end();
	});
}

function roleFile(role) {
	return path.join(STATE_DIR, `${role}.json`);
}

function roleToUserId(env, role) {
	if (role === 'cfo') return env.CFO_USER_ID;
	if (role === 'dpo') return env.DPO_USER_ID;
	if (role === 'ops') return env.OPS_USER_ID;
	throw new Error(`Unsupported role: ${role}`);
}

async function getManagementAccessToken(env) {
	const domain = env.AUTH0_DOMAIN;
	const mgmtTokenResp = await requestJson(domain, 'POST', '/oauth/token', {
		grant_type: 'client_credentials',
		client_id: env.AUTH0_TOKEN_VAULT_CLIENT_ID,
		client_secret: env.AUTH0_TOKEN_VAULT_CLIENT_SECRET,
		audience: `https://${domain}/api/v2/`
	});

	if (mgmtTokenResp.status < 200 || mgmtTokenResp.status >= 300 || !mgmtTokenResp.json?.access_token) {
		throw new Error(`Management token failed (${mgmtTokenResp.status}): ${mgmtTokenResp.body}`);
	}

	return mgmtTokenResp.json.access_token;
}

async function getConnectedAccounts(env, mgmtAccessToken, role) {
	const domain = env.AUTH0_DOMAIN;
	const userId = roleToUserId(env, role);
	const connectedResp = await requestJson(
		domain,
		'GET',
		`/api/v2/users/${encodeURIComponent(userId)}/connected-accounts`,
		null,
		mgmtAccessToken
	);

	if (connectedResp.status < 200 || connectedResp.status >= 300) {
		throw new Error(`Connected accounts check failed (${connectedResp.status}): ${connectedResp.body}`);
	}

	return connectedResp.json;
}

async function initFlow(role, code) {
	const env = loadEnv();
	const domain = env.AUTH0_DOMAIN;
	const redirectUri = env.AUTH0_CONNECTED_ACCOUNTS_REDIRECT_URI || DEFAULT_CONNECTED_ACCOUNTS_REDIRECT_URI;

	const tokenResp = await requestJson(domain, 'POST', '/oauth/token', {
		grant_type: 'authorization_code',
		client_id: env.AUTH0_CLIENT_ID,
		client_secret: env.AUTH0_CLIENT_SECRET,
		code,
		redirect_uri: redirectUri
	});

	if (tokenResp.status < 200 || tokenResp.status >= 300 || !tokenResp.json?.access_token) {
		throw new Error(`Authorization code exchange failed (${tokenResp.status}): ${tokenResp.body}`);
	}

	const myAccountToken = tokenResp.json.access_token;

	const state = `${role}-${crypto.randomUUID()}`;
	const connectResp = await requestJson(
		domain,
		'POST',
		'/me/v1/connected-accounts/connect',
		{
			connection: 'google-oauth2',
			redirect_uri: redirectUri,
			state,
			scopes: ['openid', 'profile', 'email']
		},
		myAccountToken
	);

	if (connectResp.status < 200 || connectResp.status >= 300) {
		throw new Error(`Connect init failed (${connectResp.status}): ${connectResp.body}`);
	}

	const authSession = connectResp.json?.auth_session;
	const connectUri = connectResp.json?.connect_uri;
	const ticket = connectResp.json?.connect_params?.ticket;

	if (!authSession || !connectUri || !ticket) {
		throw new Error(`Connect init missing fields: ${JSON.stringify(connectResp.json)}`);
	}

	fs.mkdirSync(STATE_DIR, { recursive: true });
	fs.writeFileSync(
		roleFile(role),
		JSON.stringify(
			{
				role,
				myAccountToken,
				authSession,
				redirectUri,
				state,
				connectUrl: `${connectUri}?ticket=${encodeURIComponent(ticket)}`
			},
			null,
			2
		)
	);

	console.log(`CONNECT_URL=${connectUri}?ticket=${encodeURIComponent(ticket)}`);
	console.log(`STATE_FILE=${roleFile(role)}`);
	console.log('Next: open CONNECT_URL, approve Google consent, then run complete with connect_code.');
}

async function completeFlow(role, connectCode) {
	const env = loadEnv();
	const domain = env.AUTH0_DOMAIN;
	const file = roleFile(role);

	if (!fs.existsSync(file)) {
		throw new Error(`Missing state file: ${file}. Run init first.`);
	}

	const state = JSON.parse(fs.readFileSync(file, 'utf8'));

	const completeResp = await requestJson(
		domain,
		'POST',
		'/me/v1/connected-accounts/complete',
		{
			auth_session: state.authSession,
			connect_code: connectCode,
			redirect_uri: state.redirectUri
		},
		state.myAccountToken
	);

	if (completeResp.status < 200 || completeResp.status >= 300) {
		throw new Error(`Connect complete failed (${completeResp.status}): ${completeResp.body}`);
	}

	const mgmtAccessToken = await getManagementAccessToken(env);
	const connected = await getConnectedAccounts(env, mgmtAccessToken, role);
	const count = connected?.connected_accounts?.length ?? 0;
	console.log(`CONNECTED_ACCOUNTS_${role.toUpperCase()}=${count}`);
	console.log(JSON.stringify(connected, null, 2));
}

async function verifyFlow() {
	const env = loadEnv();
	const mgmtAccessToken = await getManagementAccessToken(env);

	for (const role of ['cfo', 'dpo']) {
		const connected = await getConnectedAccounts(env, mgmtAccessToken, role);
		const count = connected?.connected_accounts?.length ?? 0;
		console.log(`CONNECTED_ACCOUNTS_${role.toUpperCase()}=${count}`);
		if (count === 0) {
			throw new Error(`Verification failed: ${role.toUpperCase()} has zero connected accounts.`);
		}
	}

	console.log('VERIFY_OK=1');
}

async function main() {
	const [, , action, roleArg, value] = process.argv;
	const role = (roleArg || '').toLowerCase();

	if (action === 'verify') {
		await verifyFlow();
		return;
	}

	if (!['cfo', 'dpo', 'ops'].includes(role)) {
		console.error('Usage: node tools/tokenvault-connected-accounts.js <init|complete> <cfo|dpo|ops> <code>');
		console.error('   or: node tools/tokenvault-connected-accounts.js verify');
		process.exit(1);
	}

	if (action === 'init') {
		if (!value) {
			console.error('Missing authorization code for init.');
			process.exit(1);
		}
		await initFlow(role, value);
		return;
	}

	if (action === 'complete') {
		if (!value) {
			console.error('Missing connect_code for complete.');
			process.exit(1);
		}
		await completeFlow(role, value);
		return;
	}

	console.error('Unknown action. Use init or complete.');
	process.exit(1);
}

main().catch((err) => {
	console.error(err.message || err);
	process.exit(1);
});

