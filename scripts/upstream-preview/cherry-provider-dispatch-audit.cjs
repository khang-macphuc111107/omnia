const http = require('node:http');
const WebSocket = require('ws');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const workspace = path.resolve(__dirname, '../..');
const profile = 'C:/Users/khang/AppData/Local/Temp/omnia-cherry-ipc-nCEV91';
const out = path.join(workspace, 'artifacts/upstream-ui/cherry-provider-dispatch-audit.json');
const port = 18190;
const calls = [];
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
    calls.push({ method: req.method, path: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      const payload = { id: 'chatcmpl-omnia', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'qwen', choices: [{ index: 0, message: { role: 'assistant', content: 'OMNIA_CHERRY_PROVIDER_DISPATCH_OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } };
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload));
    } else { res.writeHead(404); res.end('not found'); }
  });
});
function cdp() { return new Promise((resolve, reject) => { http.get('http://127.0.0.1:9229/json', res => { let d=''; res.on('data', x => d += x); res.on('end', () => { const target = JSON.parse(d).find(x => x.title === 'Cherry Studio'); if (!target) return reject(new Error('Cherry target missing')); const ws = new WebSocket(target.webSocketDebuggerUrl); let id=0; const pending=new Map(); ws.on('open',()=>resolve({ eval: (expression) => new Promise((ok,bad)=>{ const n=++id; pending.set(n,{ok,bad}); ws.send(JSON.stringify({id:n,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}})); }), close:()=>ws.close() })); ws.on('message', msg => { const m=JSON.parse(msg); const p=pending.get(m.id); if (!p) return; pending.delete(m.id); if (m.error) p.bad(new Error(JSON.stringify(m.error))); else p.ok(m.result?.result?.value); }); ws.on('error', reject); }); }).on('error', reject); }); }
async function request(api, method, pathName, body) { const script = `window.api.dataApi.request(${JSON.stringify({ id: 'omnia-' + Date.now() + '-' + Math.random(), method, path: pathName, body, metadata: { timestamp: Date.now() } })}).then(x => JSON.stringify(x))`; return JSON.parse(await api.eval(script)); }
async function countDb() { const { spawnSync } = require('node:child_process'); const code = "import sqlite3,json,sys\np=sys.argv[1]\nc=sqlite3.connect('file:'+p+'?mode=ro',uri=True)\nprint(json.dumps({'t':c.execute('select count(*) from topic').fetchone()[0],'m':c.execute('select count(*) from message').fetchone()[0]}))"; const db=path.join(profile,'userData','Data','cherrystudio.sqlite'); const r=spawnSync('python',['-c',code,db],{encoding:'utf8'}); if(r.status!==0) throw new Error(r.stderr||'sqlite probe failed'); return JSON.parse(r.stdout); }
(async () => { server.listen(port, '127.0.0.1'); const api = await cdp(); const before = await countDb(); const provider = await request(api, 'POST', '/providers', { providerId: 'omnia-loopback', presetProviderId: 'openai', name: 'Omnia Loopback', endpointConfigs: { 'openai-chat-completions': { baseUrl: `http://127.0.0.1:${port}/v1` } }, defaultChatEndpoint: 'openai-chat-completions', authConfig: { type: 'api-key', required: false }, apiKeys: [{ id: crypto.randomUUID(), key: 'omnia-loopback-key', label: 'Omnia loopback', isEnabled: true }], providerSettings: {} }); const model = await request(api, 'POST', '/models', [{ providerId: 'omnia-loopback', modelId: 'qwen', name: 'Omnia Qwen', endpointTypes: ['openai-chat-completions'], supportsStreaming: true, capabilities: [] }]); const generated = JSON.parse(await api.eval(`window.api.ipcApi.request('ai.text.generate', ${JSON.stringify({ uniqueModelId:'omnia-loopback::qwen', prompt:'Reply with the exact marker.', requestOptions:{ timeout:10000 } })}).then(x => JSON.stringify(x))`)); const after = await countDb(); const report = { generatedAt: new Date().toISOString(), profile, mock: { baseUrl: `http://127.0.0.1:${port}/v1`, calls, noExternalNetwork: calls.every(c => c.headers.host?.startsWith('127.0.0.1')) }, setup: { providerStatus: provider.status, modelStatus: model.status }, database: { before, after }, response: generated, checks: { providerConfigured: provider.status === 201 || provider.status === 409, modelConfigured: model.status === 201 || model.status === 409, loopbackRequestReceived: calls.some(c => c.path === '/v1/chat/completions'), markerReturned: generated?.data?.text === 'OMNIA_CHERRY_PROVIDER_DISPATCH_OK', messageCountStable: after.m === before.m }, limitation: 'One-shot ai.text.generate was dispatched through the native IPC router to a loopback OpenAI-compatible server. This does not claim renderer stream event parity or real provider behavior.' }; fs.writeFileSync(out, JSON.stringify(report,null,2)+'\n'); console.log(JSON.stringify(report)); api.close(); server.close(); })().catch(e=>{console.error(e); server.close(); process.exitCode=1});


