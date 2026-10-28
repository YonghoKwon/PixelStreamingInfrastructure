const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers/cirrus-v3-harness');

function negotiated(h, ue, p, id='A') { p.message({type:'subscribe',streamerId:id}); ue.message({type:'offer',playerId:h.playerId(p),sdp:'v=0'}); }

test('K: two established viewers protect UE while two new offer timeouts close only new browsers', () => {
    const h=createHarness(); const ue=h.streamer(); const a=h.player(), b=h.player(); negotiated(h,ue,a); negotiated(h,ue,b);
    const c=h.player(), d=h.player(); for(const p of [c,d]) p.message({type:'subscribe',streamerId:'A'});
    h.advance(20000); assert.equal(h.commands.length,0); assert.equal(ue.readyState,1);
    for(const p of [a,b]) assert.equal(p.readyState,1);
    for(const p of [c,d]) { assert.equal(p.readyState,2); assert.deepEqual(p.closeCalls.at(-1),{code:1000,reason:''}); }
    assert.equal(h.run('startRetryStatus.attempts'),0); assert.equal(h.run('offerWaitTimers.size'),0);
});

test('K: one established viewer protects UE from a new browser and a closed viewer does not', () => {
    for(const open of [true,false]) {
        const h=createHarness(); const ue=h.streamer(); const a=h.player(); negotiated(h,ue,a);
        if(!open) a.finishClose(); const b=h.player(); b.message({type:'subscribe',streamerId:'A'}); h.advance(20000);
        assert.equal(h.commands.length,open?0:1); assert.equal(b.readyState,2);
        if(open) { assert.equal(a.readyState,1); assert.equal(ue.readyState,1); }
    }
});

test('K: viewers negotiated with an old UE instance do not protect a replacement UE', () => {
    const h=createHarness(); const old=h.streamer(); const a=h.player(), b=h.player();
    for(const p of [a,b]) { negotiated(h,old,p); p.close=()=>{}; }
    const current=h.streamer(); const waiting=h.player(); waiting.message({type:'subscribe',streamerId:'A'});
    h.advance(20000); assert.equal(h.commands.length,1); assert.equal(current.readyState,2);
});

test('K: without any negotiated viewer the original single/multiple-waiter zombie recovery remains', () => {
    for(const count of [1,3]) {
        const h=createHarness(); const ue=h.streamer();
        for(let i=0;i<count;i++) h.player().message({type:'subscribe',streamerId:'A'});
        h.advance(20000); assert.equal(h.commands.length,1); assert.equal(ue.readyState,2);
    }
});

test('K: current SFU offer delivery protects multiple SFU viewers without changing R1 reset rules', () => {
    const h=createHarness(); h.streamer(); const sfu=h.sfu(); sfu.message({type:'subscribe',streamerId:'A'}); sfu.message({type:'startStreaming'});
    const a=h.player(),b=h.player();
    for(const p of [a,b]) { p.message({type:'subscribe',streamerId:'SFU'}); sfu.message({type:'offer',playerId:h.playerId(p),sdp:'v=0'}); }
    const c=h.player(); c.message({type:'subscribe',streamerId:'SFU'}); h.advance(20000);
    assert.equal(h.commands.length,0); assert.equal(a.readyState,1); assert.equal(b.readyState,1); assert.equal(sfu.readyState,1); assert.equal(c.readyState,2);
});
