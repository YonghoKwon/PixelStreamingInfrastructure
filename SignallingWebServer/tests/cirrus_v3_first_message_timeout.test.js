const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers/cirrus-v3-harness');

test('first-message timeout is off by default: silent browsers are kept', () => {
    const h = createHarness(); h.streamer();
    const silent = h.player(), active = h.player();
    active.message({ type: 'listStreamers' });
    h.advance(600000);
    assert.equal(silent.terminateCalls, 0); assert.equal(h.count(), 2);
});

test('enabled: only the browser that never sent a message is terminated at the deadline', () => {
    const h = createHarness({ PlayerFirstMessageTimeoutMs: 30000 }, { autoOffer: true }); const ue = h.streamer();
    const silent = h.player(), active = h.player();
    h.advance(100); active.message({ type: 'listStreamers' }); active.message({ type: 'subscribe', streamerId: 'A' });
    h.advance(29899); assert.equal(silent.terminateCalls, 0); assert.equal(h.count(), 2);
    h.advance(1);
    assert.equal(silent.terminateCalls, 1); assert.equal(active.terminateCalls, 0);
    assert.equal(active.readyState, 1); assert.equal(ue.readyState, 1); assert.equal(h.count(), 1);
    assert.ok(h.logs.some(entry => entry.args.join(' ').includes('closing silent socket')));
    h.advance(600000); assert.equal(active.terminateCalls, 0); assert.equal(h.count(), 1);
});

test('enabled: a browser that closes before the deadline is not touched again', () => {
    const h = createHarness({ PlayerFirstMessageTimeoutMs: 5000 }); h.streamer();
    const early = h.player();
    h.advance(1000); early.finishClose(1005);
    h.advance(10000); assert.equal(early.terminateCalls, 0); assert.equal(h.count(), 0);
});

test('enabled: removing the last silent browser starts the idle timer like any disconnect', () => {
    const h = createHarness({ PlayerFirstMessageTimeoutMs: 30000 }); h.streamer();
    h.player();
    h.advance(30000);
    assert.equal(h.count(), 0); assert.notEqual(h.run('idleTimerStartTime'), null);
});

test('first-message timeout accepts zero and integer bounds, rejects other values', () => {
    for (const n of [0, 5000, 600000]) createHarness({ PlayerFirstMessageTimeoutMs: n }).player();
    for (const n of [-1, 1, 4999, 600001, 5000.5, '30000', null]) {
        assert.throws(() => createHarness({ PlayerFirstMessageTimeoutMs: n }), /Invalid PlayerFirstMessageTimeoutMs/);
    }
});

test('enabled: UE registration auto-subscribes only waiting browsers that have sent a message', () => {
    const h = createHarness({ PlayerFirstMessageTimeoutMs: 30000, AppAutoStart: false, AppIdleTimeoutMs: 0 }, { autoOffer: true });
    const silent = h.player(), active = h.player();
    active.message({ type: 'listStreamers' });
    const ue = h.streamer(); h.advance(1000);
    const connected = ue.sent.filter(m => m.type === 'playerConnected').map(m => m.playerId);
    assert.deepEqual(connected, [h.playerId(active)]);
    assert.ok(!h.run(`players.get('${h.playerId(silent)}').streamerId`));
    h.advance(29000); assert.equal(silent.terminateCalls, 1); assert.equal(active.readyState, 1);
});

test('disabled: UE registration still auto-subscribes every waiting browser (F7a unchanged)', () => {
    const h = createHarness({ AppAutoStart: false, AppIdleTimeoutMs: 0 });
    const silent = h.player(), active = h.player();
    active.message({ type: 'listStreamers' });
    const ue = h.streamer(); h.advance(1000);
    const connected = ue.sent.filter(m => m.type === 'playerConnected').map(m => m.playerId).sort();
    assert.deepEqual(connected, [h.playerId(silent), h.playerId(active)].sort());
});
