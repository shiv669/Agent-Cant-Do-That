const http = require('http');

function httpRequest(method, url, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: { 'Content-Type': 'application/json', ...headers }
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, data: parsed });
        } catch {
          resolve({ status: res.statusCode, data: data || 'No response body' });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
  try {
    console.log('📋 Fresh CIBA + Token Vault Test\n');

    // New offboarding
    console.log('1️⃣ Starting fresh offboarding workflow...');
    const off = await httpRequest('POST', 'http://localhost:4001/api/workflows/offboarding/start', 
      { customerId: 'cust-' + Date.now() });
    const { workflowId, customerId } = off.data;
    console.log('✅ Workflow:', workflowId);

    // Request authority window (triggers CIBA)
    console.log('\n2️⃣ Requesting authority window (CIBA)...');
    const win = await httpRequest('POST', 'http://localhost:4001/api/authority/window/request',
      {
        workflowId,
        customerId,
        actionScope: 'execute:refund',
        boundAgentClientId: 'subagent-d-only',
        amount: 100000,
        ttlSeconds: 120
      },
      { 'x-agent-client-id': 'orchestrator-a' }
    );
    const windowId = win.data.windowId;
    console.log('✅ Window:', windowId);
    
    // Wait for CIBA approval
    console.log('\n3️⃣ Waiting for CIBA approval (this will take ~15-30s)...');
    let approved = false;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const ledger = await httpRequest('GET', `http://localhost:4001/api/workflows/${workflowId}/ledger`);
      const events = ledger.data || [];
      if (events.some(e => e.eventType === 'step_up_approved')) {
        console.log('\n✅ CIBA Approved!');
        approved = true;
        break;
      }
      if (i % 5 === 0) process.stdout.write('.');
    }

    if (!approved) throw new Error('CIBA approval timeout');

    // Claim window (THIS TRIGGERS TOKEN VAULT MINT)
    console.log('4️⃣ Claiming window (triggers Token Vault mint)...');
    const claim = await httpRequest('POST', 'http://localhost:4001/api/authority/window/claim',
      { windowId, claimantAgentClientId: 'subagent-d-only' },
      { 'x-agent-client-id': 'subagent-d-only' }
    );
    
    if (claim.status === 200 || claim.status === 201) {
      console.log('\n✅✅✅ CLAIM SUCCESSFUL!');
      console.log('✅✅✅ TOKEN VAULT MINT SUCCESSFUL!');
      console.log('✅✅✅ MFA POLICY CHANGE FIXED IT!\n');
      console.log(`Token returned: ${claim.data.authorityWindowToken.substring(0, 30)}...`);
      process.exit(0);
    } else {
      console.log('\n❌ Claim failed:', claim.status);
      console.log('Response:', claim.data);
      process.exit(1);
    }
  } catch(e) {
    console.error('\n❌ Error:', e.message);
    process.exit(1);
  }
})();
