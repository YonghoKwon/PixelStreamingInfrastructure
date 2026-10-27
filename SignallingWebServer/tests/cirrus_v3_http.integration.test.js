const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const WS = require('ws');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { const end = Date.now() + 5000; while (Date.now() < end) { const result = fn(); if (result) return result; await pause(10); } throw new Error('Server test deadline exceeded'); }
async function freePort() { const s = net.createServer(); await new Promise(resolve => s.listen(0, '127.0.0.1', resolve)); const port = s.address().port; await new Promise(resolve => s.close(resolve)); return port; }
async function start(overrides = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cirrus-v3-http-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>QA fixture player</title>');
    fs.writeFileSync(path.join(dir, 'fixture.js'), 'window.qaFixture = true;');
    const ports = []; while (ports.length < 3) { const p = await freePort(); if (!ports.includes(p)) ports.push(p); }
    const serverRoot = path.resolve(__dirname, '..');
    const config = { UseFrontend: false, UseHTTPS: false, UseMatchmaker: false, UseAuthentication: false, EnableWebserver: true,
        LogToFile: false, LogVerbose: false, HttpPort: ports[0], StreamerPort: ports[1], SFUPort: ports[2],
        HomepageFile: path.join(dir, 'index.html'), AdditionalRoutes: { '/qa-static': path.relative(serverRoot, dir) }, ...overrides };
    const file = path.join(dir, 'config.json'); fs.writeFileSync(file, JSON.stringify(config));
    const child = spawn(process.execPath, [path.join(serverRoot, 'cirrus_v3_codex.js'), '--configFile', file], { cwd: dir });
    const s = { child, config, dir, sockets: [], logs: '', exit: null };
    child.stdout.on('data', bytes => s.logs += bytes); child.stderr.on('data', bytes => s.logs += bytes);
    child.on('exit', (code, signal) => s.exit = { code, signal });
    await until(() => s.logs.includes('Http listening') || s.exit !== null);
    assert.equal(s.exit, null, s.logs); return s;
}
function get(s, route) { return new Promise((resolve, reject) => http.get('http://127.0.0.1:' + s.config.HttpPort + route, r => { let body = ''; r.on('data', b => body += b); r.on('end', () => resolve({ status: r.statusCode, body, headers: r.headers })); }).on('error', reject)); }
async function socket(s, port) {
    const w = new WS('ws://127.0.0.1:' + port); w.rows = []; s.sockets.push(w);
    w.on('message', b => w.rows.push(JSON.parse(String(b)))); w.on('error', () => {});
    await new Promise((resolve, reject) => { w.once('open', resolve); w.once('error', reject); }); return w;
}
async function close(s) {
    // Stop the owned server BEFORE disconnecting synthetic streamer endpoints.
    // No real /dt/run.sh is ever invoked by these tests.
    if (s.exit === null) { s.child.kill('SIGTERM'); await until(() => s.exit !== null); }
    for (const w of s.sockets) w.terminate();
}
test('default preserves certificate-only policy and offers separate liveness/readiness', async () => {
    const s = await start(); try {
        const root = await get(s, '/'); assert.equal(root.status, 200); assert.match(root.body, /HTTP 연결 확인/); assert.ok(!root.body.includes('QA fixture player'));
        assert.equal((await get(s, '/healthz')).status, 200); const ready = await get(s, '/readyz'); assert.equal(ready.status, 503); assert.equal(JSON.parse(ready.body).mediaValidated, false);
    } finally { await close(s); }
});
test('web opt-in serves HTML and JS and returns a real 404', async () => {
    const s = await start({ HttpMode: 'web' }); try {
        assert.match((await get(s, '/')).body, /QA fixture player/);
        const script = await get(s, '/qa-static/fixture.js'); assert.equal(script.status, 200); assert.match(script.body, /window.qaFixture/); assert.match(script.headers['content-type'], /javascript/);
        assert.equal((await get(s, '/missing-fixture')).status, 404);
        assert.match((await get(s, '/cert-check')).body, /HTTP 연결 확인/);
    } finally { await close(s); }
});
test('real endpoint receives original ICE credentials but console and file logs never contain them', async () => {
    const secret = 'QA_V3_NETWORK_SECRET_7391';
    const s = await start({ LogToFile: true, LogVerbose: true, peerConnectionOptions: JSON.stringify({ iceServers: [{ urls: ['turn:localhost'], credential: secret }] }) });
    try {
        const st = await socket(s, s.config.StreamerPort); await until(() => st.rows.some(m => m.type === 'identify'));
        st.send(JSON.stringify({ type: 'endpointId', id: 'QA-ONLY-SYNTHETIC' })); st.send(JSON.stringify({ type: 'ping', time: 1 })); await until(() => st.rows.some(m => m.type === 'pong'));
        const p = await socket(s, s.config.HttpPort); const config = await until(() => p.rows.find(m => m.type === 'config'));
        assert.equal(config.peerConnectionOptions.iceServers[0].credential, secret);
        const ready = JSON.parse((await get(s, '/readyz')).body); assert.equal(ready.ready, true); assert.equal(ready.mediaValidated, false);
        await pause(100); assert.equal(s.logs.includes(secret), false);
        const files = fs.readdirSync(path.join(s.dir, 'logs')); assert.ok(files.length > 0);
        for (const file of files) assert.equal(fs.readFileSync(path.join(s.dir, 'logs', file), 'utf8').includes(secret), false);
    } finally { await close(s); }
});

test('real sockets stay idle for 95 seconds without a ping-triggered restart', {
    skip: process.env.CIRRUS_REALTIME_IDLE_SMOKE !== '1'
}, async () => {
    const s = await start();
    try {
        const st = await socket(s, s.config.StreamerPort);
        await until(() => st.rows.some(m => m.type === 'identify'));
        st.send(JSON.stringify({type:'endpointId',id:'QA-IDLE-ONLY'}));
        st.send(JSON.stringify({type:'ping',time:1}));
        await until(() => st.rows.some(m => m.type === 'pong'));
        const p = await socket(s, s.config.HttpPort);
        await until(() => p.rows.some(m => m.type === 'config'));
        const departed = new Promise(resolve => p.once('close', resolve)); p.close(); await departed;
        await pause(95000);
        const health = JSON.parse((await get(s, '/healthz')).body);
        assert.equal(health.browsers, 0);
        assert.equal(health.ueStreamers, 1);
        assert.equal(health.streamerHealth.state, 'stale');
        assert.equal(health.launcher.state, 'idle');
        assert.equal(st.readyState, WS.OPEN);
        assert.equal(s.logs.includes('3D 앱 재시작'), false);
        assert.equal(s.logs.includes('3D 앱 시작 요청'), false);
        assert.equal(s.logs.includes('UE ping: stale'), true);
    } finally { await close(s); }
});

test('real connected browser and UE sockets survive 95 seconds without JSON keepalives', {
    skip: process.env.CIRRUS_REALTIME_PING_SMOKE !== '1'
}, async () => {
    const s = await start();
    try {
        const st = await socket(s, s.config.StreamerPort);
        await until(() => st.rows.some(m => m.type === 'identify'));
        st.send(JSON.stringify({type:'endpointId',id:'QA-CONNECTED-ONLY'}));
        st.send(JSON.stringify({type:'ping',time:1}));
        await until(() => st.rows.some(m => m.type === 'pong'));
        const p = await socket(s, s.config.HttpPort);
        await until(() => p.rows.some(m => m.type === 'config'));
        await pause(95000);
        const health = JSON.parse((await get(s, '/healthz')).body);
        assert.equal(health.browsers, 1); assert.equal(health.ueStreamers, 1);
        assert.equal(health.streamerHealth.state, 'stale');
        assert.equal(health.launcher.state, 'idle');
        assert.equal(p.readyState, WS.OPEN); assert.equal(st.readyState, WS.OPEN);
        assert.equal(s.logs.includes('3D 앱 재시작'), false);
        assert.equal(s.logs.includes('3D 앱 시작 요청'), false);
    } finally { await close(s); }
});
