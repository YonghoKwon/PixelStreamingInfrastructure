const test=require('node:test');
const assert=require('node:assert/strict');
const {createHarness}=require('./helpers/cirrus-v3-harness');
const stops=h=>h.commands.filter(c=>/Stop_|run\.sh stop/.test(c.command));
const starts=h=>h.commands.filter(c=>/Start_|run\.sh restart/.test(c.command));

function stopping(overrides={}) {
    const h=createHarness({AppIdleTimeoutMs:60000,...overrides},{realClosingSend:true});
    const ue=h.streamer(),a=h.player(),b=h.player();
    assert.equal(h.count(),2);a.finishClose();b.finishClose();
    ue.close=()=>{}; // Delay the close event until after exhausted was assigned, as in real ws.
    h.advance(60000);assert.equal(stops(h).length,1);h.complete();
    return {h,ue};
}
function exhausted(overrides={},completeLast=true) {
    const state=stopping(overrides);
    for(let i=0;i<4;i++){state.h.advance(15000);if(i<3||completeLast)state.h.complete();}
    assert.equal(stops(state.h).length,5);
    assert.equal(state.h.run('getServiceStatus().stopRetry.state'),'exhausted');
    return state;
}

test('LIFE R2(a): real close after exhaustion plus UE return in three seconds preserves exhaustion for thirty minutes',()=>{
    const {h,ue}=exhausted();ue.finishClose(1011,'idle shutdown retry 4');
    assert.equal(h.run('stopRetryStatus.state'),'exhausted');
    h.advance(3000);h.streamer();
    assert.equal(h.run('streamerGoneTimerId'),null);
    assert.equal(h.run('idleTimer.active'),false);
    const idleLogs=h.logs.filter(l=>l.args.join(' ').includes('유휴 타이머 시작')).length;
    h.advance(30*60000);
    assert.equal(h.run('getServiceStatus().stopRetry.state'),'exhausted');
    assert.equal(stops(h).length,5);assert.equal(starts(h).length,0);
    assert.equal(h.logs.filter(l=>l.args.join(' ').includes('유휴 타이머 시작')).length,idleLogs);
});

for(const guard of ['none','zombie','command']) {
    test(`LIFE R2(b): five seconds genuinely without UE clears exhaustion even with ${guard} guard`,()=>{
        const {h,ue}=exhausted({},guard!=='command');
        if(guard==='zombie')h.run('zombieRestartInProgress=true; appRunning=true');
        ue.finishClose(1011,'idle shutdown retry 4');h.advance(4999);
        assert.equal(h.run('stopRetryStatus.state'),'exhausted');
        const running=h.run('appRunning');h.advance(1);
        assert.equal(h.run('stopRetryStatus.state'),'idle');
        if(guard!=='none')assert.equal(h.run('appRunning'),running,'existing appRunning guard unchanged');
        if(guard==='command'){assert.equal(h.run('appCommandInProgress'),h.run('STOP_CMD'));h.complete();}
        if(guard==='zombie')h.run('zombieRestartInProgress=false');
        h.streamer();assert.equal(h.run('idleTimerStartTime'),h.run('Date.now()'));
        assert.equal(h.run('idleTimer.active'),true);
        h.advance(59999);assert.equal(stops(h).length,5);
        h.advance(1);assert.equal(stops(h).length,6);
    });
}

test('LIFE R2(c): existing retry loop still confirms complete UE termination and stops retrying',()=>{
    const {h,ue}=stopping();ue.finishClose();h.advance(15000);
    assert.equal(h.run('stopRetryTimer'),null);assert.equal(h.run('stopRetryStatus.state'),'idle');
    assert.equal(stops(h).length,1);assert.equal(starts(h).length,0);
    assert.ok(h.logs.some(l=>l.args.join(' ').includes('스트리머 완전 종료 확인')));
});

for(const autoStart of [true,false]) {
    test(`LIFE R2(d): two viewers reset exhaustion after a short disconnect, autoStart=${autoStart}`,()=>{
        const {h,ue}=exhausted({AppAutoStart:autoStart});ue.finishClose();h.advance(3000);
        assert.equal(h.run('stopRetryStatus.state'),'exhausted');
        const a=h.player(),b=h.player();
        assert.equal(h.count(),2);assert.equal(a.readyState,1);assert.equal(b.readyState,1);
        assert.equal(h.run('stopRetryStatus.state'),'idle');
        assert.equal(starts(h).length,autoStart?1:0);
        if(autoStart)h.complete();h.streamer();h.advance(120000);
        assert.equal(starts(h).length,autoStart?1:0);assert.equal(stops(h).length,5);
        assert.equal(h.run('idleTimerStartTime'),null);
    });
}
