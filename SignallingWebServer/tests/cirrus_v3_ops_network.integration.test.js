const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { start, socket, get, until } = require('./helpers/cirrus-ops-server');

test('actual ws rejects oversized player, UE and SFU frames with 1009 while server stays live', async () => {
    const s = await start({ MaxWebSocketPayloadBytes: 65536 });
    try {
        const ue = await socket(s, s.config.StreamerPort);
        ue.send(JSON.stringify({ type: 'endpointId', id: 'OPS-UE' }));
        await until(() => s.logs.includes('Registered new streamer: OPS-UE'));
        for (const port of [s.config.HttpPort, s.config.SFUPort, s.config.StreamerPort]) {
            const w = await socket(s, port); const closed = once(w, 'close');
            w.send('x'.repeat(65537)); const [code] = await closed; assert.equal(code, 1009);
            assert.equal((await get(s, '/healthz')).status, 200);
        }
    } finally { await s.close(); }
});

test('renamed cirrus.js supports Korean disconnect reasons and records redacted errors on stderr and file', async () => {
    const secret = 'OPS_NETWORK_CREDENTIAL_91';
    const s = await start({ peerConnectionOptions: JSON.stringify({ iceServers: [{ credential: secret }] }) }, { renamed: true });
    try {
        const ue = await socket(s, s.config.StreamerPort);
        ue.send(JSON.stringify({ type: 'endpointId', id: 'OPS-UE' }));
        await until(() => s.logs.includes('Registered new streamer: OPS-UE'));
        const p = await socket(s, s.config.HttpPort, '/?OfferToReceive=false');
        await until(() => p.rows.some(row => row.type === 'config'));
        p.send(JSON.stringify({ type: 'subscribe', streamerId: 'OPS-UE' }));
        const connected = await until(() => ue.rows.find(row => row.type === 'playerConnected'));
        const closed = once(p, 'close');
        ue.send(JSON.stringify({ type: 'disconnectPlayer', playerId: connected.playerId, reason: '한글😀'.repeat(80) }));
        const [code, reason] = await closed; assert.equal(code, 1011); assert.ok(reason.length <= 123);
        ue.send(JSON.stringify({ type: 'ping', time: 123 }));
        await until(() => ue.rows.find(row => row.type === 'pong' && row.time === 123));
        ue.send(JSON.stringify({ type: 'layerPreference' })); // No side effects.
        const bad = await socket(s, s.config.SFUPort); const badClosed = once(bad, 'close');
        bad.send('{malformed'); await badClosed;
        await until(() => s.stderr.includes('Cannot parse SFU message'));
        const files = fs.readdirSync(path.join(s.dir, 'logs')).filter(name => name.endsWith('.error.log'));
        const contents = await until(() => files.map(name => fs.readFileSync(path.join(s.dir, 'logs', name), 'utf8')).join('\n').includes('Cannot parse SFU message'));
        assert.ok(contents); assert.ok(!s.stderr.includes(secret)); assert.ok(!s.logs.includes(secret));
        for (const name of fs.readdirSync(path.join(s.dir, 'logs'))) {
            assert.ok(!fs.readFileSync(path.join(s.dir, 'logs', name), 'utf8').includes(secret));
        }
        assert.ok(!s.stderr.includes('DEP0169')); assert.equal((await get(s, '/readyz')).status, 200);
    } finally { await s.close(); }
});
