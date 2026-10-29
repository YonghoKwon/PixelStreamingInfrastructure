const test=require('node:test');
const assert=require('node:assert/strict');
const {createHarness}=require('./helpers/cirrus-v3-harness');
const stops=h=>h.commands.filter(c=>/Stop_|run\.sh stop/.test(c.command));
const starts=h=>h.commands.filter(c=>/Start_|run\.sh restart/.test(c.command));

function stopping(overrides={}){
    const h=createHarness(overrides);const ue=h.streamer();
    ue.close=()=>{}; // STOP did not end the externally owned UE/socket.
    h.advance(600000);assert.equal(stops(h).length,1);h.complete();
    return {h,ue};
}
function exhausted(overrides={}){
    const state=stopping(overrides);
    for(let i=0;i<4;i++){state.h.advance(15000);state.h.complete();}
    assert.equal(state.h.run('stopRetryStatus.state'),'exhausted');
    assert.equal(stops(state.h).length,5);return state;
}

test('LIFE R1(a): UE re-registration during STOP retries never renews the expired idle timer',()=>{
    const {h}=stopping();const prior=h.run('idleTimer'),at=h.run('idleTimerStartTime');
    assert.notEqual(h.run('stopRetryTimer'),null);assert.equal(h.run('appCommandInProgress'),null);
    h.streamer();assert.equal(h.run('idleTimer'),prior);assert.equal(h.run('idleTimerStartTime'),at);
    assert.equal(h.run('idleTimer.active'),false);assert.equal(stops(h).length,1);
});

test('LIFE R1(b): repeated UE registration after four retries adds zero STOPs for thirty minutes',()=>{
    const {h}=exhausted();const before=h.run('idleTimerStartTime');
    for(let i=0;i<6;i++){
        h.streamer();h.advance(300000);
        assert.equal(stops(h).length,5);assert.equal(h.run('getServiceStatus().stopRetry.state'),'exhausted');
        assert.equal(h.run('stopRetryTimer'),null);assert.equal(h.run('idleTimer.active'),false);
        assert.equal(h.run('idleTimerStartTime'),before);
    }
    assert.equal(starts(h).length,0);
});

test('LIFE R1(c): two viewers clear exhaustion; later standalone UE gets a new normal idle deadline',()=>{
    const {h}=exhausted();const a=h.player(),b=h.player();
    assert.equal(h.run('stopRetryStatus.state'),'idle');assert.equal(h.run('idleTimerStartTime'),null);
    a.finishClose();b.finishClose();h.advance(1000);h.streamer();
    assert.equal(h.run('idleTimerStartTime'),h.run('Date.now()'));
    h.advance(599999);assert.equal(stops(h).length,5);h.advance(1);assert.equal(stops(h).length,6);
    assert.equal(starts(h).length,0);
});

test('LIFE R1(d): two viewers reset exhausted status and reuse the live UE under both START policies',()=>{
    for(const autoStart of [true,false]){
        const {h,ue}=exhausted({AppAutoStart:autoStart});const a=h.player(),b=h.player();
        assert.equal(h.count(),2);assert.equal(a.readyState,1);assert.equal(b.readyState,1);assert.equal(ue.readyState,1);
        assert.equal(h.run('getServiceStatus().stopRetry.state'),'idle');assert.equal(h.run('idleTimerStartTime'),null);
        h.advance(120000);assert.equal(stops(h).length,5);assert.equal(starts(h).length,0);
    }
});

test('LIFE R1 reset: observed complete UE disconnect clears exhaustion and allows standalone registration grace',()=>{
    const {h,ue}=exhausted();ue.finishClose();h.advance(5000);
    assert.equal(h.run('stopRetryStatus.state'),'idle');h.streamer();
    assert.equal(h.run('idleTimerStartTime'),h.run('Date.now()'));assert.equal(h.run('idleTimer.active'),true);
    h.advance(599999);assert.equal(stops(h).length,5);h.advance(1);assert.equal(stops(h).length,6);
});
