const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers/cirrus-v3-harness');

test('J: wrong UE cannot send offer/answer/ICE or disconnect any of three A subscribers', () => {
    const h = createHarness(); const a = h.streamer(), b = h.streamer('B'); const viewers = [h.player(), h.player(), h.player()];
    for (const p of viewers) {
        p.message({ type: 'subscribe', streamerId: 'A' }); const id = h.playerId(p), before = p.sent.length;
        for (const type of ['offer','answer','iceCandidate']) b.message({ type, playerId:id, sdp:'forged' });
        b.message({ type:'disconnectPlayer', playerId:id, reason:'forged' });
        assert.equal(p.sent.length, before); assert.equal(p.readyState, 1);
        for (const type of ['offer','iceCandidate']) a.message({ type, playerId:id, sdp:'valid' });
        assert.equal(p.sent.at(-2).type, 'offer'); assert.equal(p.sent.at(-1).type, 'iceCandidate');
    }
    a.message({ type:'disconnectPlayer', playerId:h.playerId(viewers[1]), reason:'intended' });
    assert.equal(viewers[1].closeCalls.at(-1).code, 1011); assert.equal(viewers[0].readyState,1); assert.equal(viewers[2].readyState,1);
});

test('J: current same-ID replacement routes to remaining subscribers; replaced UE cannot route', () => {
    const h = createHarness(); const old = h.streamer(); const viewers = [h.player(),h.player(),h.player()];
    for (const p of viewers) { p.message({ type:'subscribe',streamerId:'A' }); p.close = () => {}; }
    const current = h.streamer();
    for (const p of viewers) {
        const id=h.playerId(p), before=p.sent.length;
        old.message({ type:'offer',playerId:id,sdp:'old' }); assert.equal(p.sent.length,before);
        current.message({ type:'offer',playerId:id,sdp:'new' }); assert.equal(p.sent.at(-1).sdp,'new');
        current.message({ type:'iceCandidate',playerId:id,candidate:{candidate:'new'} }); assert.equal(p.sent.at(-1).candidate.candidate,'new');
    }
});

test('J: subscribed SFU receives UE forwarding and SFU forwards only to its own multi-viewer subscribers', () => {
    const h=createHarness(); const ue=h.streamer(); const sfu=h.sfu();
    sfu.message({type:'subscribe',streamerId:'A'}); ue.message({type:'offer',playerId:h.playerId(sfu),sdp:'UE-SFU'});
    assert.equal(sfu.sent.at(-1).sdp,'UE-SFU'); sfu.message({type:'startStreaming'});
    const direct=h.player(), a=h.player(), b=h.player(); direct.message({type:'subscribe',streamerId:'A'});
    for(const p of [a,b]) p.message({type:'subscribe',streamerId:'SFU'});
    const before=direct.sent.length;
    for(const p of [direct,a,b]) sfu.message({type:'offer',playerId:h.playerId(p),sdp:'SFU-offer'});
    assert.equal(direct.sent.length,before); assert.equal(a.sent.at(-1).sdp,'SFU-offer'); assert.equal(b.sent.at(-1).sdp,'SFU-offer');
});
