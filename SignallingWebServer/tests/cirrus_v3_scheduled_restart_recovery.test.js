'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createHarness}=require('./helpers/cirrus-v3-harness');
const monday=new Date(2026,10,9,3,58).getTime();
const make=(overrides={})=>createHarness({AppAutoStart:true,AppIdleTimeoutMs:60000,AppRestartTime:'04:00',...overrides},
    {now:monday,autoOffer:true,closedSendCallback:true});
const commands=h=>h.commands.map(c=>/Stop_/.test(c.command)?'STOP':'START');

for(const when of ['before reservation','during busy reservation']){
    test(`schedule recovery: queued browser START continues normally during reservation wait (${when})`,()=>{
        const h=make(),ue=h.streamer();h.advance(60000);ue.finishClose();
        let viewer;
        if(when==='before reservation')viewer=h.player();
        h.advance(60000);
        if(when==='during busy reservation')viewer=h.player();
        assert.equal(h.run('scheduledRestartActive.phase'),'busy');
        h.complete();
        assert.deepEqual(commands(h),['STOP','START']);
        h.complete();h.streamer();h.advance(1000);
        assert.ok(viewer.sent.some(m=>m.type==='offer'));
        h.advance(28999);
        assert.deepEqual(commands(h),['STOP','START']);
        h.advance(1);
        assert.deepEqual(commands(h),['STOP','START','STOP']);
        assert.equal(h.run('scheduledRestartActive.owned'),true);
        assert.equal(viewer.closeCalls[0].code,1012);
    });
}

test('schedule recovery: queued idle STOP survives START completion during reservation',()=>{
    const h=make();const viewer=h.player();viewer.finishClose();h.advance(60000);
    assert.equal(h.run('stopAfterStart'),true);h.advance(60000);
    h.complete();assert.deepEqual(commands(h),['START','STOP']);
    h.complete();h.advance(30000);
    assert.equal(h.run('scheduledRestartLast.result'),'skipped:ue-off');
    assert.deepEqual(commands(h),['START','STOP']);
});

test('schedule recovery: new browser cancels queued STOP before START completion',()=>{
    const h=make(),first=h.player();first.finishClose();h.advance(120000);
    assert.equal(h.run('stopAfterStart'),true);
    const second=h.player();assert.equal(h.run('stopAfterStart'),false);
    h.advance(1000);second.finishClose();h.complete();
    h.advance(29000);
    assert.equal(h.run('scheduledRestartLast.result'),'skipped:ue-off');
    assert.deepEqual(commands(h),['START']);
    h.advance(30999);assert.deepEqual(commands(h),['START']);
    h.advance(1);assert.deepEqual(commands(h),['START','STOP']);
});

test('schedule recovery: completed START releases STOP promptly and no stale STOP repeats',()=>{
    const h=make(),first=h.player();first.finishClose();h.advance(120000);
    h.complete();assert.deepEqual(commands(h),['START','STOP']);
    const second=h.player();assert.equal(h.run('startAfterStop'),true);
    h.advance(1000);second.finishClose();h.complete();h.advance(60000);
    assert.equal(h.run('scheduledRestartLast.result'),'skipped:ue-off');
    assert.deepEqual(commands(h),['START','STOP']);
});

test('schedule recovery: browser arriving during busy wait cancels idle STOP retries',()=>{
    const h=make();h.streamer();h.advance(120000);
    assert.notEqual(h.run('stopRetryTimer'),null);
    assert.equal(h.run('scheduledRestartActive.phase'),'busy');
    h.player();assert.equal(h.run('stopRetryTimer'),null);
    assert.deepEqual(commands(h),['STOP']);
});

test('schedule recovery: leaving during busy wait preserves remaining idle deadline',()=>{
    const h=make();const viewer=h.player();h.advance(120000);viewer.finishClose();
    const departure=h.run('Date.now()');h.complete();h.advance(30000);
    assert.equal(h.run('scheduledRestartLast.result'),'skipped:ue-off');
    assert.equal(h.run('idleTimerStartTime'),departure);
    h.advance(29999);assert.deepEqual(commands(h),['START']);
    h.advance(1);assert.deepEqual(commands(h),['START','STOP']);
});

test('schedule recovery: expired idle cleanup resumes immediately after a busy skip',()=>{
    const h=make();const viewer=h.player();h.advance(120000);viewer.finishClose();
    h.advance(90000);assert.deepEqual(commands(h),['START']);
    h.complete();assert.deepEqual(commands(h),['START','STOP']);
    h.complete();h.advance(30000);
    assert.equal(h.run('scheduledRestartLast.result'),'skipped:ue-off');
    assert.deepEqual(commands(h),['START','STOP']);
});

test('schedule recovery: busy cooldown round skips START but keeps the next slow retry',()=>{
    const h=make({AppIdleTimeoutMs:0,AppStartMaxAttempts:1,AppStartCooldownMs:120000});
    h.player();h.advance(120000);
    assert.equal(h.run('scheduledRestartActive.phase'),'busy');
    assert.notEqual(h.run('startRetryTimer'),null);
    assert.deepEqual(commands(h),['START']);
    h.complete();h.advance(30000);
    assert.equal(h.run('scheduledRestartLast.result'),'skipped:ue-off');
    h.advance(89999);assert.deepEqual(commands(h),['START']);
    h.advance(1);assert.deepEqual(commands(h),['START','START']);
    assert.equal(h.run('startRetryStatus.slowRetries'),1);
});

for(const arrival of ['during command','after command']){
    test(`schedule recovery: browser ${arrival} preserves original START registration deadline`,()=>{
        const h=createHarness({AppAutoStart:true,AppIdleTimeoutMs:0,AppRestartTime:'04:00'},
            {now:new Date(2026,10,9,3,59,50).getTime(),autoOffer:true,closedSendCallback:true});
        h.player();h.advance(10000);
        if(arrival==='after command')h.complete();
        h.player();
        if(arrival==='during command')h.complete();
        h.advance(30000);
        assert.equal(h.run('scheduledRestartLast.result'),'skipped:ue-off');
        assert.deepEqual(commands(h),['START']);
        assert.equal(h.run('appStartTime'),new Date(2026,10,9,3,59,50).getTime());
        h.advance(50000);assert.deepEqual(commands(h),['START']);
        h.advance(30000);assert.deepEqual(commands(h),['START','START']);
    });
}

function withheldOffer(){
    const h=make({AppIdleTimeoutMs:0}),ue=h.streamer();h.advance(120000);h.complete();ue.finishClose();h.advance(5250);
    const viewer=h.player(),fresh=h.streamer();fresh.withheldOfferPlayers.add(h.playerId(viewer));h.advance(21000);
    return {h,viewer};
}

test('schedule recovery: streamer-gone watchdog retains normal recovery during busy observation',()=>{
    const h=createHarness({AppAutoStart:true,AppIdleTimeoutMs:0,AppRestartTime:'04:00'},
        {now:new Date(2026,10,9,3,59,50).getTime(),autoOffer:true,closedSendCallback:true});
    h.player();h.advance(11000);const transient=h.streamer();transient.finishClose();
    h.advance(1000);h.complete();h.advance(1000);const waiting=h.player();
    h.advance(3000);
    assert.deepEqual(commands(h),['START','START']);
    assert.equal(h.run('scheduledRestartActive.owned'),undefined);
    h.complete();h.streamer();h.advance(1250);
    assert.ok(waiting.sent.some(m=>m.type==='offer'));
});

test('schedule recovery: F7a subscription continues before reservation ownership is acquired',()=>{
    const h=make({AppIdleTimeoutMs:0});h.player();h.advance(120000);
    const waiting=h.player();h.streamer();h.advance(1000);
    assert.ok(waiting.sent.some(m=>m.type==='offer'));
    assert.deepEqual(commands(h),['START']);
    assert.equal(h.run('scheduledRestartActive.owned'),undefined);
    h.complete();h.advance(29000);
    assert.equal(h.run('scheduledRestartActive.owned'),true);
    assert.equal(waiting.closeCalls[0].code,1012);
});

test('schedule recovery: offer watchdog defers during restart then resumes normal recovery',()=>{
    const {h,viewer}=withheldOffer();
    assert.equal(h.run('offerWaitTimers.size'),1);
    assert.deepEqual(commands(h),['STOP','START']);
    assert.equal(viewer.closeCalls.length,0);
    h.complete();h.advance(250);assert.equal(h.run('scheduledRestartLast.result'),'ok');
    h.advance(20000);assert.deepEqual(commands(h),['STOP','START','START']);
});

test('schedule recovery: deferred offer watchdog is removed when the viewer leaves',()=>{
    const {h,viewer}=withheldOffer();viewer.finishClose();h.advance(60000);
    assert.equal(h.run('offerWaitTimers.size'),0);
    assert.deepEqual(commands(h),['STOP','START']);
    h.complete();h.advance(250);assert.equal(h.run('scheduledRestartLast.result'),'ok');
});
