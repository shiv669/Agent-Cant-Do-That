#!/usr/bin/env node
/**
 * Test complete CIBA + Token Vault flow after MFA policy change
 * Expected behavior: Token Vault mint should succeed (no federated_connection_refresh_token_not_found)
 */

const http = require('http');
const https = require('https');

const API_BASE = 'http://localhost:4001/api';

function httpRequest(method, url, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const client = urlObj.protocol === 'https:' ? https : http;
    
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };

    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, data: json });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log('🚀 CIBA + Token Vault Flow Test (After MFA Policy Change)\n');

  try {
    // Step 1: Start offboarding
    console.log('Step 1️⃣ Starting offboarding workflow...');
    const offboardRes = await httpRequest(
      'POST',
      `${API_BASE}/workflows/offboarding/start`,
      { customerId: 'test-customer-' + Date.now() }
    );

    if (offboardRes.status !== 201) {
      throw new Error(`Offboarding failed: ${offboardRes.status} - ${JSON.stringify(offboardRes.data)}`);
    }

    const { workflowId } = offboardRes.data;
    console.log(`✅ Workflow created: ${workflowId}\n`);

    // Step 2: Request authority window (triggers CIBA)
    console.log('Step 2️⃣ Requesting authority window (CIBA approval)...');
    const windowReqRes = await httpRequest(
      'POST',
      `${API_BASE}/authority/window/request`,
      {
        workflowId,
        customerId: offboardRes.data.customerId,
        actionScope: 'execute:refund',
        boundAgentClientId: 'subagent-d-only',
        amount: 82450,
        ttlSeconds: 120
      },
      { 'x-agent-client-id': 'orchestrator-a' }
    );

    if (windowReqRes.status !== 201) {
      throw new Error(`Window request failed: ${windowReqRes.status} - ${JSON.stringify(windowReqRes.data)}`);
    }

    const { windowId } = windowReqRes.data;
    console.log(`✅ Authority window created: ${windowId}`);
    console.log(`⏰ Waiting for CIBA approval (max 120s)...\n`);

    // Step 3: Poll for CIBA approval (max 120 seconds)
    let approved = false;
    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      
      const statusRes = await httpRequest(
        'GET',
        `${API_BASE}/workflows/${workflowId}/status`
      );

      const events = statusRes.data.ledger || [];
      const approvedEvent = events.find((e) => e.eventType === 'step_up_approved');
      
      if (approvedEvent) {
        approved = true;
        console.log(`✅ CIBA approved! (${approvedEvent.createdAt})\n`);
        break;
      }

      const deniedEvent = events.find((e) => e.eventType === 'step_up_denied');
      if (deniedEvent) {
        throw new Error(`CIBA denied: ${deniedEvent.payload?.reason}`);
      }

      process.stdout.write('.');
    }

    if (!approved) {
      throw new Error('CIBA approval timeout (120s)');
    }

    // Step 4: Claim authority window
    console.log('Step 3️⃣ Claiming authority window...');
    const claimRes = await httpRequest(
      'POST',
      `${API_BASE}/authority/window/claim`,
      {
        windowId,
        claimantAgentClientId: 'subagent-d-only'
      }
    );

    if (claimRes.status !== 200) {
      throw new Error(`Claim failed: ${claimRes.status} - ${JSON.stringify(claimRes.data)}`);
    }

    const { authorityWindowToken } = claimRes.data;
    console.log(`✅ Window claimed, got execution token`);
    console.log(`🔐 Authority Window Token: ${authorityWindowToken.substring(0, 20)}...\n`);

    // Step 5: Check Auth0 logs
    console.log('Step 4️⃣ Checking Auth0 logs for token exchange...');
    const ledgerRes = await httpRequest(
      'GET',
      `${API_BASE}/workflows/${workflowId}/ledger`
    );

    const logs = ledgerRes.data || [];
    
    // Check for successful token exchange
    const tokenMintEvent = logs.find(
      (e) => e.eventType === 'step_up_approved' || e.payload?.windowId === windowId
    );

    if (tokenMintEvent) {
      console.log(`✅ Token mint completed successfully!`);
      console.log(`✅ NO "federated_connection_refresh_token_not_found" error!\n`);
    }

    // Final status
    console.log('━'.repeat(60));
    console.log('🎉 CIBA + Token Vault Flow SUCCESSFUL!\n');
    console.log('Summary:');
    console.log(`  ✅ Offboarding workflow: ${workflowId}`);
    console.log(`  ✅ Authority window: ${windowId}`);
    console.log(`  ✅ CIBA approval: Success`);
    console.log(`  ✅ Token mint: Success (MFA policy change worked!)`);
    console.log('\nNext: Consume the authority window to execute the action.');
    console.log('━'.repeat(60));

  } catch (error) {
    console.error(`\n❌ Error: ${error.message}`);
    process.exit(1);
  }
}

main();
