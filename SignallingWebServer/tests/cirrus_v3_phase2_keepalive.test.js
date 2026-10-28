const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers/cirrus-v3-harness');

test('I: only non-pong browser out of three is terminated, remaining viewers prevent idle STOP', () => {
    const h = createHarness(); const ue = h.streamer(); const a = h.player(), b = h.player(), c = h.player();
    for (const p of [a,b,c]) p.message({ type: 'subscribe', streamerId: 'A' });
    for (const p of [a,b,c]) ue.message({ type: 'offer', playerId: h.playerId(p), sdp: 'v=0' });
    const deadId = h.playerId(b); b.autoPong = false;
    h.advance(59999); assert.equal(h.count(), 3); h.advance(1);
    assert.equal(b.terminateCalls, 1); assert.equal(a.readyState, 1); assert.equal(c.readyState, 1);
    assert.equal(ue.readyState, 1); assert.equal(h.count(), 2); assert.equal(h.run('idleTimerStartTime'), null);
    assert.deepEqual(ue.sent.filter(m => m.type === 'playerDisconnected').map(m => m.playerId), [deadId]);
    a.finishClose(); c.autoPong = false; h.advance(60000);
    assert.equal(h.count(), 0); assert.equal(h.run('idleTimerStartTime'), 1120000);
    assert.equal(b.listenerCount('pong'), 0); const pings = b.pingCalls;
    h.advance(599999); assert.equal(b.pingCalls, pings); assert.equal(h.commands.length, 0);
    h.advance(1); assert.equal(h.commands.length, 1);
});

test('I: protocol pong keeps multiple browsers alive, UE/SFU never receive server control pings', () => {
    const h = createHarness(); const ue = h.streamer(), sfu = h.sfu(); const a = h.player(), b = h.player();
    h.advance(180000); assert.equal(a.pingCalls, 6); assert.equal(b.pingCalls, 6);
    assert.equal(ue.pingCalls, 0); assert.equal(sfu.pingCalls, 0); assert.equal(a.terminateCalls + b.terminateCalls, 0);
    a.finishClose(); b.finishClose(); assert.equal(a.listenerCount('pong'), 0); assert.equal(b.listenerCount('pong'), 0);
});

test('I: disabling keepalive preserves all silent browsers and START budget is not renewed on cleanup', () => {
    const disabled = createHarness({ PlayerKeepaliveTimeoutMs: 0 }); disabled.streamer();
    const a = disabled.player(), b = disabled.player(); a.autoPong = b.autoPong = false;
    disabled.advance(600000); assert.equal(a.pingCalls + b.pingCalls, 0); assert.equal(disabled.count(), 2);
    const h = createHarness({ AppStartMaxAttempts: 1 }); const c = h.player(), d = h.player(); h.complete();
    c.autoPong = false; h.advance(60000); assert.equal(c.terminateCalls, 1); assert.equal(d.readyState, 1);
    assert.equal(h.run('startRetryStatus.attempts'), 1); assert.equal(h.run('startRetryStatus.state'), 'exhausted');
});

test('I: keepalive configuration accepts zero and integer bounds, rejects other values', () => {
    for (const n of [0,5000,600000]) { const h = createHarness({ PlayerKeepaliveTimeoutMs:n }); h.player(); h.player(); }
    for (const n of [-1,1,4999,600001,5000.5,'30000',null]) assert.throws(() => createHarness({ PlayerKeepaliveTimeoutMs:n }), /Invalid PlayerKeepaliveTimeoutMs/);
});
