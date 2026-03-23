const { Client } = require('pg');
const https = require('https');
const fs = require('fs');
function envLoad(){const out={};for(const l of fs.readFileSync('.env','utf8').split(/\r?\n/)){const m=l.match(/^(\w+)=(.*)$/);if(!m)continue;let v=m[2].trim();if(v.startsWith("'")&&v.endsWith("'"))v=v.slice(1,-1);out[m[1]]=v;}return out;}
function post(host,path,obj){const body=JSON.stringify(obj);return new Promise((res,rej)=>{const req=https.request({hostname:host,path,method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res({status:r.statusCode,body:d}));});req.on('error',rej);req.write(body);req.end();});}
(async()=>{
 const env=envLoad();
 const db=new Client({connectionString:'postgresql://postgres:postgres@localhost:5432/agentcantdothat'});
 await db.connect();
 const r=await db.query('select ciba_subject_token, action_scope from authority_windows order by created_at desc limit 1');
 await db.end();
 const subject=r.rows[0].ciba_subject_token; const scope=r.rows[0].action_scope;
 const requested=[
  'http://auth0.com/oauth/token-type/federated-connection-access-token',
  'http://auth0.com/oauth/token-type/token-vault-access-token',
  'http://auth0.com/oauth/token-type/token-vault-refresh-token'
 ];
 for(const rt of requested){
   const payload={
     grant_type:'urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token',
     client_id:env.AUTH0_TOKEN_VAULT_CLIENT_ID,
     client_secret:env.AUTH0_TOKEN_VAULT_CLIENT_SECRET,
     subject_token:subject,
     subject_token_type:'urn:ietf:params:oauth:token-type:access_token',
     requested_token_type:rt,
     connection:'google-oauth2',
     login_hint: scope==='execute:refund'?env.CFO_TOKEN_VAULT_LOGIN_HINT:env.DPO_TOKEN_VAULT_LOGIN_HINT
   };
   const out=await post(env.AUTH0_DOMAIN,'/oauth/token',payload);
   console.log('requested_token_type=',rt,'status=',out.status,'body=',out.body);
 }
})();
