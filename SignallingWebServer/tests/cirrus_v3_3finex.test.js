const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness } = require('./helpers/cirrus-v3-harness');
const { start, socket, until, pause } = require('./helpers/cirrus-ops-server');
const entry = 'cirrus_v3_3Finex.js';
const harness = (config = {}) => createHarness(config, { entry, autoOffer: true });
const info = { uuid: 'QA-3FINEX-UUID', userEmpNo: 'QA-EMP-7394', userName: 'QA-NAME-7394' };
const add = (p, values = info) => p.message({ type: 'addUser', streamerId: 'A', ...values });
const stored = (h, p) => JSON.parse(h.run(`JSON.stringify((({uuid,userEmpNo,userName}) => ({uuid,userEmpNo,userName}))(players.get(${JSON.stringify(h.playerId(p))})))`));
const request = (s, route, method = 'GET', headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: s.config.HttpPort, path: route, method, headers }, res => {
        let body = ''; res.on('data', b => body += b);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }); req.on('error', reject); req.end();
});
const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': 'Content-Type, Authorization',
    'access-control-allow-credentials': 'true'
};

test('3Finex: addUser before/after subscribe overwrites fields, stays open and never forwards to UE', () => {
    const h = harness(); const p = h.player(); add(p); assert.deepEqual(stored(h, p), info);
    h.complete(); const ue = h.streamer(); p.message({ type: 'subscribe', streamerId: 'A' }); h.advance(0);
    add(p, { uuid: 123, userEmpNo: 456, userName: 'Updated' });
    assert.deepEqual(stored(h, p), { uuid: '123', userEmpNo: '456', userName: 'Updated' });
    assert.equal(p.readyState, 1); assert.equal(p.closeCalls.length, 0);
    assert.equal(ue.sent.some(m => m.type === 'addUser'), false);
    assert.ok(p.sent.some(m => m.type === 'offer'));
});

test('3Finex: invalid fields are ignored individually, including boundary lengths and missing fields', () => {
    const h = harness(); const p = h.player(); add(p);
    for (const value of [null, {}, [], true, 'x'.repeat(257)]) {
        add(p, { uuid: value, userEmpNo: value, userName: 'Valid' });
        assert.deepEqual(stored(h, p), { ...info, userName: 'Valid' });
    }
    add(p, { uuid: 'x'.repeat(256), userEmpNo: 0, userName: '' });
    assert.deepEqual(stored(h, p), { uuid: 'x'.repeat(256), userEmpNo: '0', userName: '' });
    add(p, {}); assert.equal(stored(h, p).uuid.length, 256); assert.equal(p.readyState, 1);
});

test('3Finex: SFU addUser is ignored without closing, forwarding or logging the payload', () => {
    const h = harness({ LogVerbose: true }); const sfu = h.sfu(); add(sfu);
    assert.deepEqual(stored(h, sfu), {}); assert.equal(sfu.readyState, 1);
    const logs = JSON.stringify(h.logs); for (const value of Object.values(info)) assert.equal(logs.includes(value), false);
    assert.equal(h.logs.filter(row => JSON.stringify(row).includes('[ADDUSER]')).length, 0);
});

test('3Finex: addUser logs only one player-id line for both verbose settings', () => {
    for (const LogVerbose of [false, true]) {
        const h = harness({ LogVerbose }); const p = h.player(); const before = h.logs.length; add(p);
        const added = h.logs.slice(before); assert.equal(added.length, 1);
        assert.equal(added[0].args.at(-1), `[ADDUSER] player ${h.playerId(p)}`);
        for (const value of Object.values(info)) assert.equal(JSON.stringify(h.logs).includes(value), false);
    }
});

test('3Finex: denied HTTP requests are rejected before the HTTPS redirect', () => {
    const h = harness({ UseHTTPS: true });
    // Network adapters are inert; execute middleware in registration order until a response.
    function dispatch(route) {
        let reply;
        const req = { method: 'GET', path: route, originalUrl: route, secure: false, headers: {}, get: () => 'localhost' };
        const res = { status(code) { this.code = code; return this; },
            send(body) { reply = { code: this.code, body }; return this; },
            redirect(url) { reply = { code: 302, url }; return this; } };
        for (const args of h.app.routes) {
            if (args.length === 1 && typeof args[0] === 'function') args[0](req, res, () => {});
            if (reply) break;
        }
        return reply;
    }
    assert.deepEqual(dispatch('/player.html'), { code: 403, body: 'Access Forbidden: ' });
    assert.deepEqual(dispatch('/foo'), { code: 403, body: 'Access Forbidden: ' });
    assert.equal(dispatch('/healthz').code, 302);
});

test('3Finex: first arrival START and last departure 60-second STOP retain v3 lifecycle', () => {
    const h = harness({ AppIdleTimeoutMs: 60000 }); const a = h.player(); const b = h.player(); add(a); add(b);
    assert.equal(h.commands.length, 1); assert.match(h.commands[0].command, /Start_/); h.complete();
    h.streamer(); h.advance(1000); a.finishClose(); h.advance(180000);
    assert.equal(h.commands.length, 1); assert.equal(b.readyState, 1); b.finishClose();
    h.advance(59999); assert.equal(h.commands.length, 1); h.advance(1);
    assert.equal(h.commands.length, 2); assert.match(h.commands[1].command, /Stop_/);
});

for (const HttpMode of ['certificate-only', 'web']) {
    test(`3Finex ${HttpMode}: five allowed paths, CORS/preflight, live list removal and protected logs`, async () => {
        const s = await start({ HttpMode, LogVerbose: true }, { entry });
        try {
            for (const route of ['/', '/cert-check']) {
                const r = await request(s, route); assert.equal(r.status, 200); assert.match(r.body, /HTTP 연결 확인/);
            }
            assert.equal((await request(s, '/healthz')).status, 200);
            assert.equal((await request(s, '/readyz')).status, 503);
            const empty = await request(s, '/link-user'); assert.equal(empty.status, 200); assert.deepEqual(JSON.parse(empty.body), []);
            const a = await socket(s, s.config.HttpPort, '/player.html'); const b = await socket(s, s.config.HttpPort);
            a.send(JSON.stringify({ type: 'addUser', ...info }));
            await until(() => s.logs.includes('[ADDUSER]')); const r = await request(s, '/link-user', 'GET', { Origin: 'https://qa.example' });
            for (const [key, value] of Object.entries(cors)) assert.equal(r.headers[key], value);
            const rows = JSON.parse(r.body); assert.equal(rows.length, 2);
            assert.deepEqual(rows.find(row => row.uuid === info.uuid), { id: rows[0].id, ...info });
            assert.deepEqual(Object.keys(rows.find(row => row.uuid === undefined)), ['id']);
            const preflight = await request(s, '/link-user', 'OPTIONS', { Origin: 'https://qa.example', 'Access-Control-Request-Method': 'GET' });
            assert.equal(preflight.status, 200); for (const [key, value] of Object.entries(cors)) assert.equal(preflight.headers[key], value);
            assert.equal(a.readyState, 1); assert.equal(b.readyState, 1);
            a.close(); await until(() => s.logs.includes('connection closed')); assert.equal(JSON.parse((await request(s, '/link-user')).body).length, 1);
            b.close(); await until(() => (s.logs.match(/connection closed/g) || []).length === 2);
            assert.deepEqual(JSON.parse((await request(s, '/link-user')).body), []);
            await pause(100); const output = s.logs + s.stderr;
            for (const value of Object.values(info)) assert.equal(output.includes(value), false);
            const logFiles = fs.readdirSync(path.join(s.dir, 'logs')); assert.ok(logFiles.length > 0);
            for (const file of logFiles) for (const value of Object.values(info)) assert.equal(fs.readFileSync(path.join(s.dir, 'logs', file), 'utf8').includes(value), false);
        } finally { await s.close(); }
    });
    test(`3Finex ${HttpMode}: all other HTTP methods and paths are forbidden including static and login`, async () => {
        const s = await start({ HttpMode, EnableWebserver: true }, { entry });
        try {
            for (const route of ['/player.html', '/player.js', '/login', '/foo', '/images/favicon-32x32.png', '/link-user/', '/LINK-USER']) {
                const r = await request(s, route); assert.equal(r.status, 403, route); assert.equal(r.body, 'Access Forbidden: ');
            }
            for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']) for (const route of ['/', '/cert-check', '/healthz', '/readyz', '/link-user']) {
                if (method === 'OPTIONS' && route === '/link-user') continue;
                const r = await request(s, route, method); assert.equal(r.status, 403, method + ' ' + route);
                if (method !== 'HEAD') assert.equal(r.body, 'Access Forbidden: ');
            }
        } finally { await s.close(); }
    });
}

test('3Finex: link-user keeps the existing 60-per-minute rate limiter', async () => {
    const s = await start({}, { entry });
    try {
        for (let n = 0; n < 60; n++) assert.equal((await request(s, '/link-user')).status, 200);
        assert.equal((await request(s, '/link-user')).status, 429);
    } finally { await s.close(); }
});
