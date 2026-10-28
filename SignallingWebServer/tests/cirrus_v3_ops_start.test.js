const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers/cirrus-v3-harness');
const starts = h => h.commands.filter(c => /Start_|run\.sh restart/.test(c.command));

test('failed launches stop at exactly N STARTs; sixty browser reconnects cannot renew budget', () => {
    for (const limit of [1, 3, 10]) {
        const h = createHarness({ AppStartMaxAttempts: limit }); const waiting = h.player();
        for (let i = 0; i < limit; i++) { h.complete(); h.advance(120000); }
        assert.equal(starts(h).length, limit);
        const state = h.run('getServiceStatus().startRetry');
        assert.equal(state.state, 'exhausted'); assert.equal(state.attempts, limit); assert.ok(state.at);
        assert.equal(h.run('getServiceStatus().ready'), false); assert.equal(waiting.readyState, 1);
        for (let i = 0; i < 60; i++) { const reconnect = h.player(); reconnect.finishClose(); h.advance(3000); }
        h.advance(600000); assert.equal(starts(h).length, limit); assert.equal(waiting.closeCalls.length, 0);
        assert.equal(h.logs.filter(row => row.name === 'warn' && row.args.join(' ').includes('[APP] START budget exhausted')).length, 1);
        assert.ok(h.logs.some(row => row.name === 'warn' && row.args.join(' ').includes('[HEARTBEAT] START budget exhausted')));
    }
});

test('launcher failures consume the same START budget as successful command returns', () => {
    const h = createHarness({ AppStartMaxAttempts: 2 }); const p = h.player();
    h.complete(0, Error('synthetic launch failure')); h.advance(120000);
    h.complete(1, Error('synthetic launch failure')); h.advance(600000);
    assert.equal(starts(h).length, 2); assert.equal(p.readyState, 1);
    assert.equal(h.run('getServiceStatus().startRetry.state'), 'exhausted');
});

test('registration without offer cannot reset budget; exhausted zombie path retains UE and browser', () => {
    const h = createHarness({ AppStartMaxAttempts: 3 }); let p = h.player(); h.complete();
    for (let i = 1; i < 3; i++) {
        const ue = h.streamer(); p.message({ type: 'subscribe', streamerId: 'A' });
        assert.equal(h.run('getServiceStatus().startRetry.attempts'), i);
        h.advance(20000); assert.equal(starts(h).length, i + 1); h.complete();
        p.finishClose(); ue.finishClose(); p = h.player();
    }
    const ue = h.streamer(); p.message({ type: 'subscribe', streamerId: 'A' }); h.advance(20000);
    assert.equal(starts(h).length, 3); assert.equal(p.readyState, 1); assert.equal(ue.readyState, 1);
    assert.equal(h.run('getServiceStatus().startRetry.state'), 'exhausted');
    assert.equal(h.run('getServiceStatus().ready'), false);
    h.player(); h.advance(120000); assert.equal(starts(h).length, 3);
});

test('first START, five-second disconnect retry and registration watchdog share a single budget', () => {
    const h = createHarness({ AppStartMaxAttempts: 3 }); const p = h.player(); h.complete();
    const ue = h.streamer(); ue.finishClose(); p.finishClose(); h.player();
    h.advance(5000); assert.equal(starts(h).length, 2); h.complete();
    h.advance(120000); assert.equal(starts(h).length, 3); h.complete();
    h.advance(600000); assert.equal(starts(h).length, 3);
});

for (const browserOffer of [false, true]) {
    test(`late UE ${browserOffer ? 'answer' : 'offer'} successfully forwarded resets exhausted budget`, () => {
        const h = createHarness({ AppStartMaxAttempts: 1 });
        const p = h.player(browserOffer ? '/?OfferToReceive=true' : '/'); h.complete(); const ue = h.streamer();
        assert.equal(h.run('getServiceStatus().startRetry.state'), 'exhausted');
        p.message({ type: 'subscribe', streamerId: 'A' });
        ue.message({ type: browserOffer ? 'answer' : 'offer', playerId: h.playerId(p), sdp: 'v=0\r\n' });
        assert.equal(h.run('getServiceStatus().startRetry.state'), 'idle');
        assert.equal(h.run('getServiceStatus().startRetry.attempts'), 0); assert.equal(h.run('getServiceStatus().ready'), true);
        p.finishClose(); ue.finishClose(); const next = h.player();
        h.advance(5000); assert.equal(starts(h).length, 2); assert.equal(next.readyState, 1);
    });
}

test('wrong offer mode, unmatched source, failed send and missing recipient cannot reset exhausted budget', () => {
    const h = createHarness({ AppStartMaxAttempts: 1 }); const p = h.player(); h.complete();
    const ue = h.streamer(); const other = h.streamer('OTHER'); p.message({ type: 'subscribe', streamerId: 'A' });
    const playerId = h.playerId(p);
    ue.message({ type: 'answer', playerId, sdp: 'v=0' });
    other.message({ type: 'offer', playerId, sdp: 'v=0' });
    ue.message({ type: 'offer', playerId: 'missing', sdp: 'v=0' });
    p.failSend = true; ue.message({ type: 'offer', playerId, sdp: 'v=0' });
    assert.equal(h.run('getServiceStatus().startRetry.state'), 'exhausted');
    assert.equal(ue.readyState, 1);
});

test('SFU subscription receives UE offer and resets budget; SFU registration alone does not', () => {
    const h = createHarness({ AppStartMaxAttempts: 1 }); h.player(); h.complete(); const ue = h.streamer(); const sfu = h.sfu();
    sfu.message({ type: 'startStreaming' }); assert.equal(h.run('getServiceStatus().startRetry.state'), 'exhausted');
    sfu.message({ type: 'subscribe', streamerId: 'A' });
    ue.message({ type: 'offer', playerId: h.playerId(sfu), sdp: 'v=0' });
    assert.equal(h.run('getServiceStatus().startRetry.state'), 'idle');
});

test('only full browser-free idle expiry renews budget; a return before expiry does not', () => {
    const h = createHarness({ AppStartMaxAttempts: 1 }); const p = h.player(); h.complete(); p.finishClose();
    h.advance(599999); assert.equal(h.run('getServiceStatus().startRetry.state'), 'exhausted');
    h.advance(1); assert.equal(h.run('getServiceStatus().startRetry.state'), 'idle');
    assert.equal(starts(h).length, 1); h.complete(); h.player(); assert.equal(starts(h).length, 2);
    const h2 = createHarness({ AppStartMaxAttempts: 1 }); const a = h2.player(); h2.complete(); a.finishClose();
    h2.advance(599999); h2.player(); h2.advance(600001);
    assert.equal(starts(h2).length, 1); assert.equal(h2.run('getServiceStatus().startRetry.state'), 'exhausted');
});

test('AppStartMaxAttempts validates integer 1..10 and signalling restart resets budget', () => {
    for (const value of [0, 11, 1.5, '3', null]) assert.throws(() => createHarness({ AppStartMaxAttempts: value }), /Invalid AppStartMaxAttempts/);
    assert.equal(createHarness().run('config.AppStartMaxAttempts'), 3);
    assert.equal(createHarness().run('getServiceStatus().startRetry.state'), 'idle');
});
