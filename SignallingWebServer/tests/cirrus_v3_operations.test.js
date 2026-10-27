const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers/cirrus-v3-harness');
const deadline = { AppCommandTimeoutMs: 1000, AppCommandKillGraceMs: 100, AppCommandMaxTimeouts: 2 };

test('whole server reaches a bounded blocked state after repeated hung Linux launches', () => {
    const h = createHarness(deadline, { platform: 'linux' });
    h.player(); h.advance(121000);
    assert.equal(h.commands.length, 2);
    assert.equal(h.run('appCommandInProgress'), null);
    assert.equal(h.run('appCommandRunner.snapshot().blockedReason'), 'TIMEOUT_LIMIT');
    const late = h.player(); assert.equal(late.closeCalls[0].code, 1013);
    h.advance(1800000); assert.equal(h.commands.length, 2);
});
test('a registered UE survives a hung foreground launcher and remains visible as degraded', () => {
    const h = createHarness(deadline, { platform: 'linux' });
    h.player(); const s = h.streamer(); h.advance(1000);
    assert.equal(h.commands[0].child.alive, true);
    assert.equal(s.readyState, 1);
    assert.equal(h.run('appRunning'), true);
    assert.equal(h.run('getServiceStatus().status'), 'degraded');
    assert.equal(h.run('getServiceStatus().ready'), false);
});
test('readiness requires actual UE registration and completed launcher; SFU is excluded', () => {
    const h = createHarness();
    assert.equal(h.run('getServiceStatus().ready'), false);
    h.player(); h.complete(0);
    const f = h.sfu(); f.message({ type: 'startStreaming' });
    assert.equal(h.run('getServiceStatus().ready'), false);
    h.streamer(); assert.equal(h.run('getServiceStatus().ready'), true);
    assert.equal(h.run('getServiceStatus().mediaValidated'), false);
});
test('sensitive config values reach endpoints unchanged but not any log method', () => {
    const secret = 'V3_QA_TURN_SENTINEL';
    const h = createHarness({ LogVerbose: true, peerConnectionOptions: JSON.stringify({ iceServers: [{ urls: ['turn:localhost'], credential: secret }] }) });
    const s = h.streamer(); const p = h.player();
    assert.equal(s.sent.find(m => m.type === 'config').peerConnectionOptions.iceServers[0].credential, secret);
    assert.equal(p.sent.find(m => m.type === 'config').peerConnectionOptions.iceServers[0].credential, secret);
    p.message({ type: 'qaUnknown', password: secret });
    assert.equal(JSON.stringify(h.logs).includes(secret), false);
});
test('health responses expose only aggregate readiness, not credentials, IDs or command paths', () => {
    const h = createHarness({ RunDir: 'private-launcher-path', peerConnectionOptions: '{"credential":"private-turn-secret"}' });
    const body = JSON.stringify(h.run('getServiceStatus()'));
    assert.equal(body.includes('private-'), false); assert.equal(body.includes('Start_'), false);
    const route = h.app.routes.find(r => r[0] === '/readyz');
    const response = { set() { return this; }, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } };
    route[1]({}, response); assert.equal(response.code, 503); assert.equal(response.data.ready, false);
});
test('blocked timeout cancels old STOP retries without closing a newly registered UE', () => {
    const h = createHarness(deadline, { platform: 'linux' });
    const p = h.player(); h.complete(0); h.streamer(); p.finishClose(); h.run('stopApp()');
    const replacement = h.streamer(); h.advance(16000);
    assert.equal(h.run('appCommandRunner.isBlocked()'), true); assert.equal(replacement.readyState, 1);
    assert.equal(h.run('stopRetryTimer'), null); assert.equal(h.commands.length, 2);
});
test('non-string message types cannot throw during unsupported-type logging', () => {
    for (const role of ['player', 'streamer', 'sfu']) {
        const h = createHarness(); const socket = role === 'player' ? h.player() : role === 'streamer' ? h.streamer() : h.sfu();
        assert.doesNotThrow(() => socket.message({ type: { toString: 'not a function' }, credential: 'INVALID_PAYLOAD_SECRET' }));
        assert.equal(socket.closeCalls[0].code, 1008);
        assert.ok(!JSON.stringify(h.logs).includes('INVALID_PAYLOAD_SECRET'));
    }
});
