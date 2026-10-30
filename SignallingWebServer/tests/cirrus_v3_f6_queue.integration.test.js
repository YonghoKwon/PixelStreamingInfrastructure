const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { start, socket, until, pause } = require('./helpers/cirrus-ops-server');

test('F6 real process: renamed cirrus.js applies production default 1000 without a VM harness or explicit gap', { timeout: 15000 }, async () => {
    const s = await start({ AppAutoStart: false, AppIdleTimeoutMs: 0 }, { renamed: true });
    try {
        assert.equal(Object.hasOwn(s.config, 'PlayerNegotiationGapMs'), false);
        assert.match(s.logs, /"PlayerNegotiationGapMs":\s*1000/);
        const ue = await socket(s, s.config.StreamerPort); const connected = [], answers = [];
        ue.on('message', raw => {
            const m = JSON.parse(String(raw));
            if (m.type === 'playerConnected') {
                connected.push({ id: m.playerId, at: Date.now() });
                ue.send(JSON.stringify({ type: 'offer', playerId: m.playerId, sdp: 'v=0\r\n' })); // Real-like synthetic UE autoOffer.
            }
            if (m.type === 'answer') answers.push({ id: m.playerId, at: Date.now() });
        });
        ue.send(JSON.stringify({ type: 'endpointId', id: 'F6-UE' }));
        await until(() => s.logs.includes('Registered new streamer: F6-UE'));
        const viewers = [];
        for (let i = 0; i < 3; i++) viewers.push(await socket(s, s.config.HttpPort));
        for (const p of viewers) p.send(JSON.stringify({ type: 'subscribe', streamerId: 'F6-UE' }));
        await until(() => viewers.some(p => p.rows.some(m => m.type === 'offer')));
        await pause(200); assert.equal(connected.length, 1);
        const answered = new Set();
        for (let i = 0; i < 3; i++) {
            // Different real sockets may reach the server in a different order.
            const active = await until(() => viewers.find(p => !answered.has(p) && p.rows.some(m => m.type === 'offer')));
            active.send(JSON.stringify({ type: 'answer', sdp: 'v=0\r\n' }));
            answered.add(active);
            await until(() => answers.length === i + 1);
            if (i < 2) {
                await until(() => connected.length === i + 2);
                assert.ok(connected[i + 1].at - answers[i].at >= 950, 'default gap must separate real messages by about one second');
            }
        }
        assert.equal(connected.length, 3);
        assert.equal(fs.existsSync(path.join(s.dir, 'launches.txt')), false);
        for (const p of viewers) assert.equal(p.readyState, 1);
    } finally { await s.close(); }
});
