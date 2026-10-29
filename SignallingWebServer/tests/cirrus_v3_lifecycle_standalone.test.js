const test=require('node:test');
const assert=require('node:assert/strict');
const {createHarness}=require('./helpers/cirrus-v3-harness');
const stops=h=>h.commands.filter(c=>/Stop_|run\.sh stop/.test(c.command));
function audience(h){const p=[h.player(),h.player()];assert.equal(h.count(),2);return p;}

test('M(a): UE registered at minute 11 stops at registration plus ten minutes; two later viewers cancel idle',()=>{
    const h=createHarness();h.advance(660000);h.streamer();assert.equal(h.run('appRunning'),true);
    assert.equal(h.run('idleTimerStartTime'),1660000);h.advance(599999);assert.equal(stops(h).length,0);
    h.advance(1);assert.equal(stops(h).length,1);audience(h);assert.equal(h.run('idleTimerStartTime'),null);
});

test('M(b): UE registered at minute 9 survives server minute 10 and stops at minute 19',()=>{
    const h=createHarness();h.advance(540000);h.streamer();h.advance(60000);assert.equal(stops(h).length,0);
    h.advance(539999);assert.equal(stops(h).length,0);h.advance(1);assert.equal(stops(h).length,1);audience(h);
});

test('M(c): three viewers present at UE registration defer idle until the last departure',()=>{
    const h=createHarness();const p=[h.player(),h.player(),h.player()];h.complete();h.streamer();
    assert.equal(h.run('idleTimerStartTime'),null);h.advance(180000);
    p[0].finishClose();p[1].finishClose();assert.equal(h.run('idleTimerStartTime'),null);
    p[2].finishClose();assert.equal(h.run('idleTimerStartTime'),1180000);
    h.advance(599999);assert.equal(stops(h).length,0);h.advance(1);assert.equal(stops(h).length,1);
});

test('M(d): two viewers arriving five minutes after standalone registration cancel its STOP',()=>{
    const h=createHarness();h.streamer();h.advance(300000);const p=audience(h);h.advance(600001);
    assert.equal(stops(h).length,0);assert.equal(h.run('idleTimerStartTime'),null);for(const v of p)assert.equal(v.readyState,1);
});

test('M(e): SFU registration never renews standalone UE idle grace, even with later multi-viewer demand',()=>{
    const h=createHarness();h.advance(660000);const before=h.run('idleTimerStartTime');
    const sfu=h.sfu();sfu.message({type:'startStreaming'});assert.equal(h.run('idleTimerStartTime'),before);
    assert.equal(stops(h).length,0);audience(h);assert.equal(h.run('idleTimerStartTime'),null);
});

test('M(f): same-ID UE replacement while three viewers are present creates no idle timer or STOP',()=>{
    const h=createHarness();h.streamer();const viewers=[h.player(),h.player(),h.player()];h.streamer();
    assert.equal(h.count(),3);assert.equal(h.run('idleTimerStartTime'),null);h.advance(600000);
    assert.equal(stops(h).length,0);assert.equal(viewers.length,3);
});

test('M(g): idle zero never schedules standalone registration shutdown; two arrivals remain supported',()=>{
    const h=createHarness({AppIdleTimeoutMs:0});h.advance(660000);h.streamer();h.advance(600000);
    assert.equal(stops(h).length,0);audience(h);assert.equal(h.run('idleTimerStartTime'),null);
});

test('M guards: STOP/blocked/zombie registration does not renew the idle deadline with two admission attempts',()=>{
    for(const guard of ['stop','blocked','zombie']){
        const h=createHarness();h.advance(660000);const before=h.run('idleTimerStartTime');
        if(guard==='stop')h.run('appRunning=true;stopApp()');
        if(guard==='blocked')h.run('appCommandRunner.isBlocked=()=>true');
        if(guard==='zombie')h.run('zombieRestartInProgress=true');
        h.streamer();assert.equal(h.run('idleTimerStartTime'),before,guard);
        h.player();h.player();assert.equal(stops(h).length,guard==='stop'?1:0,guard);
    }
});
