const test=require('node:test');
const assert=require('node:assert/strict');
const {createHarness:baseHarness}=require('./helpers/cirrus-v3-harness');
const createHarness=config=>baseHarness(config,{realClosingSend:true});
const external={AppAutoStart:false,AppIdleTimeoutMs:0};
const starts=h=>h.commands.filter(c=>/Start_|run\.sh restart/.test(c.command));
const stops=h=>h.commands.filter(c=>/Stop_|run\.sh stop/.test(c.command));
const audience=h=>[h.player(),h.player(),h.player()];
function trapDispatch(h){h.run('var startDispatchAttempts=0;var realRunAppCommand=runAppCommand;runAppCommand=function(command,callback,slow){if(command===START_CMD){startDispatchAttempts++;return false;}return realRunAppCommand(command,callback,slow);}');}
function idleBudget(h){assert.equal(h.run('startRetryStatus.state'),'idle');assert.equal(h.run('startRetryStatus.attempts'),0);assert.equal(h.run('startRetryTimer'),null);}

test('N3-1 browser demand: three waiters plus sixty reconnects never enter START or flood its cause log',()=>{
    const h=createHarness(external);trapDispatch(h);const waiting=audience(h);
    for(let i=0;i<60;i++){const p=h.player();p.finishClose();h.advance(2000);}
    assert.equal(starts(h).length,0);assert.equal(h.run('startDispatchAttempts'),0);assert.equal(h.count(),3);
    for(const p of waiting)assert.equal(p.readyState,1);idleBudget(h);
    assert.equal(h.logs.filter(r=>r.name==='warn'&&r.args.join(' ').includes('(browser-demand)')).length,1);
});

test('N3-2 registration watchdog: even a legacy startup timestamp cannot restart with three waiters',()=>{
    const h=createHarness(external);audience(h);trapDispatch(h);
    h.run('appStartTime=Date.now();startStreamerWatchdog()');h.advance(120000);
    assert.equal(starts(h).length,0);assert.equal(h.run('startDispatchAttempts'),0);idleBudget(h);
});

test('N3-3 streamer disconnect: daily external restart retains no START and three reconnected viewers receive offers',()=>{
    const h=createHarness(external);const ue=h.streamer();const old=audience(h);
    for(const p of old){p.message({type:'subscribe',streamerId:'A'});ue.message({type:'offer',playerId:h.playerId(p),sdp:'v=0'});}
    trapDispatch(h);ue.finishClose();for(const p of old)p.finishClose();const viewers=audience(h);
    h.advance(5000);h.advance(90000);assert.equal(h.run('startDispatchAttempts'),0);assert.equal(starts(h).length,0);
    const replacement=h.streamer();
    for(const p of viewers){assert.ok(p.sent.some(m=>m.type==='streamerList'&&m.ids.includes('A')));p.message({type:'subscribe',streamerId:'A'});replacement.message({type:'offer',playerId:h.playerId(p),sdp:'external replacement'});assert.equal(p.sent.at(-1).sdp,'external replacement');assert.equal(p.readyState,1);}
    idleBudget(h);assert.equal(h.run('idleTimerStartTime'),null);
});

test('N3-4 after STOP: new demand cannot queue START and a legacy queued resume is also rejected',()=>{
    const h=createHarness({...external,AppIdleTimeoutMs:60000});h.streamer();h.run('stopApp()');const viewers=audience(h);
    assert.equal(h.run('startAfterStop'),false);h.run('startAfterStop=true');trapDispatch(h);h.complete();h.advance(15000);
    assert.equal(stops(h).length,1);assert.equal(starts(h).length,0);assert.equal(h.run('startDispatchAttempts'),0);
    for(const p of viewers)assert.equal(p.readyState,1);idleBudget(h);
});

test('N3-5 zombie: close only the timed-out waiter, with or without two negotiated viewers',()=>{
    for(const negotiated of [false,true]){
        const h=createHarness(external);const ue=h.streamer();const [a,b,c]=audience(h);
        if(negotiated)for(const p of [a,b]){p.message({type:'subscribe',streamerId:'A'});ue.message({type:'offer',playerId:h.playerId(p),sdp:'v=0'});}
        trapDispatch(h);c.message({type:'subscribe',streamerId:'A'});h.advance(20000);
        assert.equal(c.readyState,2);assert.deepEqual(c.closeCalls.at(-1),{code:1000,reason:''});
        assert.equal(a.readyState,1);assert.equal(b.readyState,1);assert.equal(ue.readyState,1);
        assert.equal(h.run('startDispatchAttempts'),0);assert.equal(starts(h).length,0);idleBudget(h);
        const another=h.player();another.message({type:'subscribe',streamerId:'A'});h.advance(20000);
        assert.equal(h.logs.filter(r=>r.name==='warn'&&r.args.join(' ').includes('(offer-timeout)')).length,1);
    }
});

test('N3-6 slow retry: a stale exhausted request is discarded for three external-mode viewers',()=>{
    const h=createHarness({...external,AppStartCooldownMs:60000});audience(h);trapDispatch(h);
    h.run("startRetryStatus={state:'exhausted',attempts:3,at:new Date().toISOString(),nextRetryAt:null,slowRetries:0};scheduleSlowStartRetry()");
    h.advance(180000);assert.equal(h.run('startDispatchAttempts'),0);assert.equal(starts(h).length,0);idleBudget(h);
});

test('N3-6 queued slow callback: disabling before its deadline cannot dispatch another START',()=>{
    const h=createHarness({AppIdleTimeoutMs:0,AppStartMaxAttempts:1,AppStartCooldownMs:60000});audience(h);h.complete();
    const before=starts(h).length;h.run('config.AppAutoStart=false');trapDispatch(h);h.advance(180000);
    assert.equal(starts(h).length-before,0);assert.equal(h.run('startDispatchAttempts'),0);idleBudget(h);
});

test('N3 central boundary rejects direct normal/slow START requests with three waiters, leaving STOP independent',()=>{
    const h=createHarness(external);audience(h);
    assert.equal(h.run('runAppCommand(START_CMD,()=>{})'),false);assert.equal(h.run('runAppCommand(START_CMD,()=>{},true)'),false);
    h.run('countStartAttempt()');assert.equal(starts(h).length,0);assert.equal(h.run('appCommandInProgress'),null);idleBudget(h);
    assert.equal(h.logs.filter(r=>r.name==='warn'&&r.args.join(' ').includes('(command-entry)')).length,1);
});

test('N2: zero idle timeout creates no timer through standalone registration or three viewer departures for 24 hours',()=>{
    for(const autoStart of [false,true]){
        const h=createHarness({AppAutoStart:autoStart,AppIdleTimeoutMs:0});h.streamer();const viewers=audience(h);
        for(const p of viewers)p.finishClose();h.advance(86400000);
        assert.equal(stops(h).length,0);assert.equal(h.run('idleTimerStartTime'),null);assert.equal(h.run('idleTimer'),null);
        assert.ok(h.logs.some(r=>r.args.join(' ').includes('HEARTBEAT')&&r.args.join(' ').includes('유휴: 자동 종료 꺼짐')));
    }
});

test('N hybrid: external-start plus 60-second idle STOP remains allowed, later three viewers never START',()=>{
    const h=createHarness({AppAutoStart:false,AppIdleTimeoutMs:60000});h.advance(30000);h.streamer();
    h.advance(30000);assert.equal(stops(h).length,0);h.advance(29999);assert.equal(stops(h).length,0);
    h.advance(1);assert.equal(stops(h).length,1);h.complete();audience(h);h.advance(120000);
    assert.equal(starts(h).length,0);idleBudget(h);
    assert.equal(h.logs.filter(r=>r.name==='warn'&&r.args.join(' ').includes('자동 기동은 꺼져 있으나')).length,1);
});

test('N4: lifecycle health fields and mode heartbeat coexist with unchanged readiness for three viewers',()=>{
    const h=createHarness(external);const viewers=audience(h);
    assert.equal(h.run('getServiceStatus().lifecycle.autoStart'),false);assert.equal(h.run('getServiceStatus().lifecycle.idleTimeoutMs'),0);
    assert.equal(h.run('getServiceStatus().ready'),false);const ue=h.streamer();assert.equal(h.run('getServiceStatus().ready'),true);
    for(const p of viewers){p.message({type:'subscribe',streamerId:'A'});ue.message({type:'offer',playerId:h.playerId(p),sdp:'v=0'});}
    h.advance(30000);assert.ok(h.logs.some(r=>r.args.join(' ').includes('Lifecycle | AppAutoStart=false | AppIdleTimeoutMs=0')));
    assert.ok(h.logs.some(r=>r.args.join(' ').includes('HEARTBEAT')&&r.args.join(' ').includes('모드: 상시(자동기동 끔)')));
    assert.equal(h.run('getServiceStatus().mediaValidated'),false);idleBudget(h);
});

test('N peer isolation: one missed pong removes only that external-mode viewer and keeps the other two',()=>{
    const h=createHarness(external);const ue=h.streamer();const viewers=audience(h);
    for(const p of viewers){p.message({type:'subscribe',streamerId:'A'});ue.message({type:'offer',playerId:h.playerId(p),sdp:'v=0'});}
    const dead=h.playerId(viewers[1]);viewers[1].autoPong=false;h.advance(60000);
    assert.equal(viewers[1].terminateCalls,1);assert.equal(viewers[0].readyState,1);assert.equal(viewers[2].readyState,1);assert.equal(ue.readyState,1);
    assert.deepEqual(ue.sent.filter(m=>m.type==='playerDisconnected').map(m=>m.playerId),[dead]);
    assert.equal(h.count(),2);assert.equal(h.commands.length,0);assert.equal(h.run('idleTimerStartTime'),null);idleBudget(h);
});

test('N subscription isolation: external mode still rejects another UE offer/disconnect for three A viewers',()=>{
    const h=createHarness(external);const a=h.streamer(),b=h.streamer('B');const viewers=audience(h);
    for(const p of viewers){p.message({type:'subscribe',streamerId:'A'});const id=h.playerId(p),before=p.sent.length;
        b.message({type:'offer',playerId:id,sdp:'wrong'});b.message({type:'disconnectPlayer',playerId:id,reason:'wrong'});
        assert.equal(p.sent.length,before);assert.equal(p.readyState,1);a.message({type:'offer',playerId:id,sdp:'correct'});assert.equal(p.sent.at(-1).sdp,'correct');}
    assert.equal(h.commands.length,0);idleBudget(h);
});
