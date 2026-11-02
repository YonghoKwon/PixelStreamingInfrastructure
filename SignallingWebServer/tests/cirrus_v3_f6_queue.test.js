const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadConfig } = require('../modules/cirrus-v3-support');
const { createHarness } = require('./helpers/cirrus-v3-harness');

// These new scenarios deliberately exercise the production policy; the real
// process test separately proves that omitting this setting defaults to 1000.
const harness = (config = {}) => createHarness({ AppAutoStart: false, AppIdleTimeoutMs: 0, PlayerNegotiationGapMs: 1000, ...config }, { autoOffer: true, closedSendCallback: true });
const people = (h, count = 3, suffix) => Array.from({ length: count }, () => h.player(suffix));
const pc = ue => ue.sent.filter(m => m.type === 'playerConnected');
const offers = p => p.sent.filter(m => m.type === 'offer');
function subscribe(h, viewers, id = 'A') { for (const p of viewers) p.message({ type: 'subscribe', streamerId: id }); h.advance(0); }
function answer(h, p) { p.message({ type: 'answer', sdp: 'v=0\r\n' }); h.advance(0); }

test('F6: default 1000 serializes three subscriptions until answer forwarding plus the full gap', () => {
    for (const autoStart of [false, true]) {
        const h = harness({ AppAutoStart: autoStart }); const ue = h.streamer(); const viewers = people(h);
        subscribe(h, viewers); assert.equal(pc(ue).length, 1);
        h.advance(5000); assert.equal(pc(ue).length, 1); answer(h, viewers[0]);
        assert.equal(ue.sent.filter(m => m.type === 'answer').length, 1);
        h.advance(999); assert.equal(pc(ue).length, 1); h.advance(1); assert.equal(pc(ue).length, 2);
        answer(h, viewers[1]); h.advance(1000); assert.equal(pc(ue).length, 3);
        answer(h, viewers[2]); h.advance(1000); assert.equal(h.run('negotiationQueues.size'), 0);
        for (const p of viewers) assert.equal(offers(p).length, 1);
        assert.equal(h.commands.length, 0); assert.equal(h.run('offerWaitTimers.size'), 0);
    }
});

test('F6: a waiting departure emits no playerConnected or spurious playerDisconnected for that UE peer', () => {
    const h = harness(); const ue = h.streamer(); const viewers = people(h); subscribe(h, viewers);
    const departedId = h.playerId(viewers[1]); viewers[1].finishClose();
    assert.equal(ue.sent.filter(m => m.type === 'playerDisconnected' && m.playerId === departedId).length, 0);
    answer(h, viewers[0]); h.advance(1000);
    assert.deepEqual(pc(ue).map(m => m.playerId), [h.playerId(viewers[0]), h.playerId(viewers[2])]);
    answer(h, viewers[2]); h.advance(1000); assert.equal(h.run('negotiationQueues.size'), 0);
});

test('F6: leaving the active slot releases remaining viewers after a gap and cancels its deadline', () => {
    const h = harness(); const ue = h.streamer(); const viewers = people(h); subscribe(h, viewers);
    viewers[0].finishClose(); h.advance(999); assert.equal(pc(ue).length, 1);
    h.advance(1); assert.equal(pc(ue).length, 2); answer(h, viewers[1]);
    h.advance(1000); answer(h, viewers[2]); h.advance(20000);
    assert.equal(pc(ue).length, 3); assert.equal(h.run('negotiationQueues.size'), 0); assert.equal(h.commands.length, 0);
});

test('F6: no answer progresses at twenty seconds and a late old answer cannot release the new active viewer', () => {
    const h = harness(); const ue = h.streamer(); const viewers = people(h); subscribe(h, viewers);
    h.advance(19999); assert.equal(pc(ue).length, 1); h.advance(1); assert.equal(pc(ue).length, 2);
    answer(h, viewers[0]); h.advance(1000); assert.equal(pc(ue).length, 2);
    answer(h, viewers[1]); h.advance(999); assert.equal(pc(ue).length, 2);
    h.advance(1); assert.equal(pc(ue).length, 3); assert.equal(h.commands.length, 0);
});

test('F6: disconnecting or replacing a UE drops its pending queue and timers without affecting the new instance', () => {
    for (const scenario of ['disconnect', 'replace']) {
        const h = harness(); const old = h.streamer(); const viewers = people(h); subscribe(h, viewers);
        if (scenario === 'disconnect') old.finishClose(); else h.streamer();
        assert.equal(h.run('negotiationQueues.size'), 0);
        for (const p of viewers) p.finishClose(); h.advance(25000);
        assert.equal(pc(old).length, 1); assert.equal(h.run('negotiationQueues.size'), 0);
        const replacement = h.streamer(); const fresh = people(h); subscribe(h, fresh);
        assert.equal(pc(replacement).length, 1); answer(h, fresh[0]); h.advance(1000);
        assert.equal(pc(replacement).length, 2); assert.equal(h.commands.length, 0);
    }
});

test('F6: different UE instances have independent active slots and answer gaps', () => {
    const h = harness(); const a = h.streamer('A'), b = h.streamer('B'); const viewers = people(h, 6);
    subscribe(h, viewers.slice(0, 3), 'A'); subscribe(h, viewers.slice(3), 'B');
    assert.equal(pc(a).length, 1); assert.equal(pc(b).length, 1);
    answer(h, viewers[0]); h.advance(1000); assert.equal(pc(a).length, 2); assert.equal(pc(b).length, 1);
    answer(h, viewers[3]); h.advance(1000); assert.equal(pc(b).length, 2); assert.equal(pc(a).length, 2);
});

test('F6: a replaced player object cannot release the active slot and stale queued objects are skipped', () => {
    const h = harness(); const ue = h.streamer(); const viewers = people(h); subscribe(h, viewers);
    for (const p of viewers.slice(0, 2)) {
        const id = h.playerId(p);
        h.run(`{ const old = players.get(${JSON.stringify(id)}); players.set(old.id, Object.assign(Object.create(Object.getPrototypeOf(old)), old)); }`);
    }
    answer(h, viewers[0]); h.advance(1000); assert.equal(pc(ue).length, 1);
    h.advance(19000); assert.equal(pc(ue).length, 2);
    assert.equal(pc(ue).at(-1).playerId, h.playerId(viewers[2]));
    assert.equal(offers(viewers[1]).length, 0);
});

test('F6: the existing no-offer zombie restart discards the old instance queue and its pending timers', () => {
    const h = harness({ AppAutoStart: true }); const ue = h.streamer(); const viewers = people(h);
    ue.withheldOfferPlayers.add(h.playerId(viewers[0])); subscribe(h, viewers);
    h.advance(20000); assert.equal(h.commands.length, 1);
    assert.equal(h.run('negotiationQueues.size'), 0);
    const sent = pc(ue).length; h.advance(20000); assert.equal(pc(ue).length, sent);
});

test('F6: zero preserves immediate three-viewer wire messages and creates no negotiation queue', () => {
    const h = harness({ PlayerNegotiationGapMs: 0 }); const ue = h.streamer(); const viewers = people(h); subscribe(h, viewers);
    assert.equal(pc(ue).length, 3); assert.equal(h.run('negotiationQueues.size'), 0);
    for (const p of viewers) assert.equal(offers(p).length, 1);
});

test('F6: queued viewers have no offer timer; the twenty-second K timer starts at actual notification in both modes', () => {
    for (const autoStart of [false, true]) {
        const h = harness({ AppAutoStart: autoStart }); const ue = h.streamer(); const viewers = people(h);
        const id = h.playerId(viewers[1]); ue.withheldOfferPlayers.add(id); subscribe(h, viewers);
        assert.equal(h.run('offerWaitTimers.size'), 0);
        h.advance(19000); assert.equal(viewers[1].closeCalls.length, 0);
        answer(h, viewers[0]); h.advance(1000); assert.equal(pc(ue).length, 2);
        assert.equal(h.run('offerWaitTimers.size'), 1);
        h.advance(19999); assert.equal(viewers[1].closeCalls.length, 0); assert.equal(pc(ue).length, 2);
        h.advance(1); assert.equal(viewers[1].closeCalls.length, 1); assert.equal(pc(ue).length, 3);
        assert.equal(ue.readyState, 1); assert.equal(viewers[0].readyState, 1); assert.equal(viewers[2].readyState, 1);
        assert.equal(h.commands.length, 0);
    }
});

test('F6: F7a queues all three waiting viewers and each valid answer admits the next one', () => {
    for (const mode of ['always-on', 'on-demand']) {
        const h = harness(require(`../config.${mode}.example.json`)); const viewers = people(h);
        if (h.commands.length) h.complete(); const ue = h.streamer();
        h.advance(999); assert.equal(pc(ue).length, 0); h.advance(1); assert.equal(pc(ue).length, 1);
        for (let i = 0; i < 3; i++) { assert.equal(offers(viewers[i]).length, 1); answer(h, viewers[i]); h.advance(1000); }
        assert.equal(pc(ue).length, 3); assert.equal(h.run('negotiationQueues.size'), 0);
        assert.equal(h.commands.length, mode === 'on-demand' ? 1 : 0);
    }
});

test('F6: SFU and browser-offer modes keep immediate signalling outside the UE-offer queue', () => {
    const h = harness(); const ue = h.streamer(); const viewers = people(h, 3, '/?OfferToReceive=true');
    // Browser-offer mode deliberately gets UE answers instead of unsolicited UE offers.
    for (const p of viewers) ue.withheldOfferPlayers.add(h.playerId(p));
    subscribe(h, viewers); assert.equal(pc(ue).length, 3); assert.ok(pc(ue).every(m => !m.sendOffer));
    for (const p of viewers) { p.message({ type: 'offer', sdp: 'v=0\r\n' }); ue.message({ type: 'answer', playerId: h.playerId(p), sdp: 'v=0\r\n' }); }
    for (const p of viewers) assert.equal(p.sent.filter(m => m.type === 'answer').length, 1);
    assert.equal(h.run('negotiationQueues.size'), 0);
    const regular = people(h); subscribe(h, regular); assert.equal(pc(ue).length, 4);
    const sfu = h.sfu(); sfu.message({ type: 'subscribe', streamerId: 'A' });
    assert.equal(pc(ue).length, 5); assert.equal(pc(ue).at(-1).sfu, true);
    sfu.message({ type: 'startStreaming' }); const viaSFU = people(h, 3); subscribe(h, viaSFU, 'SFU');
    assert.equal(sfu.sent.filter(m => m.type === 'playerConnected').length, 3);
    assert.equal(h.run('negotiationQueues.size'), 1);
});

test('F6: defaults and integer gap validation reject invalid values without printing them', () => {
    const defaults = { HttpMode: 'certificate-only', AppCommandTimeoutMs: 60000, AppCommandKillGraceMs: 5000, AppCommandMaxTimeouts: 3 };
    assert.equal(loadConfig('unused', defaults, {}, { readFileSync: () => '{}' }).PlayerNegotiationGapMs, 1000);
    for (const n of [0, 100, 10000]) { const h = harness({ PlayerNegotiationGapMs: n }); people(h); assert.equal(h.run('config.PlayerNegotiationGapMs'), n); }
    for (const n of [99, 10001, '1000', 1.5, null, false]) assert.throws(() => harness({ PlayerNegotiationGapMs: n }), e => e.code === 'INVALID_CONFIG' && e.message.includes('(value omitted)'));
});

test('F6: both example configs load gap 1000 and a non-redacted explanation with three-viewer operation', () => {
    const defaults = { HttpMode: 'certificate-only', AppCommandTimeoutMs: 60000, AppCommandKillGraceMs: 5000, AppCommandMaxTimeouts: 3 };
    for (const mode of ['always-on', 'on-demand']) {
        const config = loadConfig(path.join(__dirname, `../config.${mode}.example.json`), defaults, {});
        assert.equal(config.PlayerNegotiationGapMs, 1000);
        assert.doesNotMatch('_설명_PlayerNegotiationGapMs' + config._설명_PlayerNegotiationGapMs, /password|secret|token|credential|key/i);
        const h = harness(config); const ue = h.streamer(); const viewers = people(h); subscribe(h, viewers);
        for (let i = 0; i < 3; i++) { assert.equal(pc(ue).length, i + 1); answer(h, viewers[i]); h.advance(1000); }
        assert.equal(h.run('negotiationQueues.size'), 0);
    }
});
