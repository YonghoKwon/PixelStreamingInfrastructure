const test = require('node:test');
const assert = require('node:assert/strict');
const alwaysOn = require('../config.always-on.example.json');
const { createHarness } = require('./helpers/cirrus-v3-harness');

function harness(autoStart = false) {
    return createHarness({ ...alwaysOn, AppAutoStart: autoStart }, { autoOffer: true, closedSendCallback: true });
}
function viewers(h, n = 3) {
    const people = Array.from({ length: n }, () => h.player());
    for (let i = 0; i < h.commands.length; i++) if (!h.commands[i].done) h.complete(i);
    return people;
}
const connected = ue => ue.sent.filter(m => m.type === 'playerConnected');
const offers = p => p.sent.filter(m => m.type === 'offer');
const automaticLogs = h => h.logs.flatMap(r => r.args.filter(a => typeof a === 'string' && a.includes(' 자동 subscribe → ')));
function negotiated(h, people, ue) {
    assert.equal(connected(ue).length, people.length);
    assert.deepEqual(connected(ue).map(m => m.playerId).sort(), people.map(p => h.playerId(p)).sort());
    for (const p of people) { assert.equal(offers(p).length, 1); assert.equal(p.readyState, 1); }
    assert.equal(h.run('offerWaitTimers.size'), 0);
}

test('F7a(a): sole UE auto-subscribes all three waiting viewers at one second in both modes', () => {
    for (const mode of [false, true]) {
        const h = harness(mode); const people = viewers(h); const ue = h.streamer();
        h.advance(999); assert.equal(connected(ue).length, 0);
        h.advance(1); negotiated(h, people, ue); assert.equal(automaticLogs(h).length, 3);
        h.advance(20000); assert.equal(connected(ue).length, 3);
        assert.equal(h.commands.length, mode ? 1 : 0); // No zombie/extra START after the real-like offers.
    }
});

test('F7a(b): client subscribe at 500ms leaves only the other two for server fallback', () => {
    for (const mode of [false, true]) {
        const h = harness(mode); const people = viewers(h); const ue = h.streamer();
        h.advance(500); people[0].message({ type: 'subscribe', streamerId: 'A' }); h.advance(0);
        assert.equal(connected(ue).length, 1); h.advance(500);
        negotiated(h, people, ue); assert.equal(automaticLogs(h).length, 2);
    }
});

test('F7a(c): closing, departed and same-ID replacement player objects are excluded', () => {
    for (const mode of [false, true]) for (const scenario of ['closing', 'departed', 'replaced']) {
        const h = harness(mode); const people = viewers(h); const ue = h.streamer(); h.advance(500);
        if (scenario === 'closing') people[0].close();
        if (scenario === 'departed') people[0].finishClose();
        if (scenario === 'replaced') {
            const id = h.playerId(people[0]);
            h.run(`{ const old = players.get(${JSON.stringify(id)}); players.set(old.id, Object.assign(Object.create(Object.getPrototypeOf(old)), old)); }`);
        }
        h.advance(500); negotiated(h, people.slice(1), ue);
        assert.equal(offers(people[0]).length, 0); assert.equal(automaticLogs(h).length, 2);
    }
});

test('F7a(d): a disconnected, closing or replaced UE cannot receive its stale scheduled subscribes', () => {
    for (const mode of [false, true]) for (const scenario of ['disconnected', 'closing', 'replaced']) {
        const h = harness(mode); const people = viewers(h); const oldUE = h.streamer(); h.advance(500);
        let replacement;
        if (scenario === 'disconnected') oldUE.finishClose();
        if (scenario === 'closing') oldUE.close();
        if (scenario === 'replaced') replacement = h.streamer();
        h.advance(500); assert.equal(connected(oldUE).length, 0); assert.equal(automaticLogs(h).length, 0);
        for (const p of people) assert.equal(offers(p).length, 0);
        if (replacement) {
            assert.equal(connected(replacement).length, 0);
            h.advance(500); negotiated(h, people, replacement); // The new registration owns its own full second.
        }
    }
});

test('F7a(e): a second streamer before the deadline prevents ambiguous automatic selection', () => {
    for (const mode of [false, true]) for (const delay of [0, 500]) {
        const h = harness(mode); const people = viewers(h); const a = h.streamer('A');
        h.advance(delay); const b = h.streamer('B'); h.advance(1500);
        assert.equal(connected(a).length, 0); assert.equal(connected(b).length, 0);
        assert.equal(automaticLogs(h).length, 0);
        for (const p of people) assert.equal(offers(p).length, 0);
    }
});

test('F7a(f): SFU players are excluded and SFU registration never starts the UE fallback', () => {
    for (const mode of [false, true]) {
        const h = harness(mode); const sfu = h.sfu(); const people = viewers(h); const ue = h.streamer();
        h.advance(1000); negotiated(h, people, ue);
        assert.ok(connected(ue).every(m => !m.sfu)); assert.equal(offers(sfu).length, 0);
        assert.equal(h.run('[...players.values()].filter(p => p.isSFU()).length'), 1);
        assert.equal(h.run('[...players.values()].find(p => p.isSFU()).streamerId'), undefined);
        const onlySFU = harness(mode); const waiting = viewers(onlySFU); const publisher = onlySFU.sfu();
        publisher.message({ type: 'startStreaming' }); onlySFU.advance(1000);
        assert.equal(publisher.sent.filter(m => m.type === 'playerConnected').length, 0);
        assert.equal(automaticLogs(onlySFU).length, 0);
        for (const p of waiting) assert.equal(offers(p).length, 0);
    }
});

test('F7a(g): one waiting viewer keeps the legacy one-second result and exact log message', () => {
    for (const mode of [false, true]) {
        const h = harness(mode); const people = viewers(h, 1); const ue = h.streamer();
        h.advance(999); assert.equal(connected(ue).length, 0); h.advance(1);
        negotiated(h, people, ue);
        assert.deepEqual(automaticLogs(h), [`[STREAMER] 대기 플레이어 ${h.playerId(people[0])} 자동 subscribe → A`]);
    }
});

test('F7a(h): always-on daily restart pushes list then offers to both reconnected viewers without client subscribe or START', () => {
    const h = harness(); const ue = h.streamer(); const people = viewers(h, 2);
    for (const p of people) p.message({ type: 'subscribe', streamerId: 'A' }); h.advance(0);
    negotiated(h, people, ue); ue.finishClose();
    for (const p of people) { assert.equal(p.readyState, 2); p.finishClose(); }
    const returned = viewers(h, 2); h.advance(60000);
    const restarted = h.streamer();
    for (const p of returned) assert.ok(p.sent.some(m => m.type === 'streamerList' && m.ids.includes('A')));
    h.advance(999); assert.equal(connected(restarted).length, 0); h.advance(1);
    negotiated(h, returned, restarted); assert.equal(automaticLogs(h).length, 2);
    assert.equal(h.commands.length, 0); h.advance(20000); assert.equal(h.commands.length, 0);
});
