const test=require('node:test');
const assert=require('node:assert/strict');
const {createHarness}=require('./helpers/cirrus-v3-harness');
const {loadConfig}=require('../modules/cirrus-v3-support');
const settings={AppStartMaxAttempts:1,AppStartCooldownMs:60000};
function waiters(h) { return [h.player(),h.player(),h.player()]; }

test('L: exhausted multi-viewer demand gets exactly one START per cooldown, reconnects never advance it',()=>{
    const h=createHarness(settings); waiters(h); h.complete();
    const at=h.run('startRetryStatus.at');
    for(let i=0;i<19;i++){const p=h.player();p.finishClose();h.advance(3000);}
    assert.equal(h.commands.length,1);h.advance(2999);assert.equal(h.commands.length,1);h.advance(1);
    assert.equal(h.commands.length,2);h.complete();h.advance(60000);assert.equal(h.commands.length,3);h.complete();
    assert.equal(h.run('startRetryStatus.state'),'exhausted');assert.equal(h.run('startRetryStatus.attempts'),3);
    assert.equal(h.run('startRetryStatus.slowRetries'),2);assert.equal(h.run('startRetryStatus.at'),at);
    assert.equal(h.run('startRetryStatus.nextRetryAt'),new Date(1180000).toISOString());
});

test('L: no browser demand makes zero slow attempts and full idle expiry cancels the timer',()=>{
    const h=createHarness(settings);const viewers=waiters(h);h.complete();for(const p of viewers)p.finishClose();
    h.advance(599999);assert.equal(h.commands.length,1);h.advance(1);
    assert.equal(h.run('startRetryStatus.state'),'idle');assert.equal(h.run('startRetryTimer'),null);
    assert.equal(h.commands.length,2);assert.match(h.commands[1].command,/Stop_/);
});

test('L: late offer after a slow attempt recovers all waiters and clears its next scheduled retry',()=>{
    const h=createHarness(settings);const viewers=waiters(h);h.complete();h.advance(60000);h.complete();const ue=h.streamer();
    for(const p of viewers){p.message({type:'subscribe',streamerId:'A'});ue.message({type:'offer',playerId:h.playerId(p),sdp:'v=0'});}
    assert.equal(h.run('startRetryStatus.state'),'idle');assert.equal(h.run('startRetryStatus.nextRetryAt'),null);
    assert.equal(h.run('startRetryTimer'),null);h.advance(180000);assert.equal(h.commands.length,2);
    for(const p of viewers)assert.equal(p.readyState,1);
});

test('L: busy or zombie round is skipped, no immediate catchup and no command overlap',()=>{
    for(const busy of ['command','zombie']){
        const h=createHarness(settings);waiters(h);if(busy==='zombie'){h.complete();h.run('zombieRestartInProgress=true');}
        h.advance(60000);assert.equal(h.commands.length,1);
        if(busy==='command')h.complete();else h.run('zombieRestartInProgress=false');
        h.advance(59999);assert.equal(h.commands.length,1);h.advance(1);assert.equal(h.commands.length,2);
    }
});

test('L: blocked runner skips a cooldown and disabled cooldown keeps original G policy',()=>{
    const h=createHarness({...settings,AppCommandTimeoutMs:1000});waiters(h);h.advance(1000);
    assert.equal(h.run('appCommandRunner.isBlocked()'),true);h.advance(179000);assert.equal(h.commands.length,1);
    assert.equal(h.run('startRetryStatus.slowRetries'),0);assert.ok(h.run('startRetryStatus.nextRetryAt'));
    const disabled=createHarness({...settings,AppStartCooldownMs:0});waiters(disabled);disabled.complete();disabled.advance(3600000);
    assert.equal(disabled.commands.length,1);assert.equal(disabled.run('startRetryTimer'),null);
    const gated=createHarness(settings);waiters(gated);gated.complete();
    gated.run('appCommandRunner.isBlocked=()=>true');gated.advance(60000);assert.equal(gated.commands.length,1);
    assert.equal(gated.count(),3);gated.run('appCommandRunner.isBlocked=()=>false');
    gated.advance(59999);assert.equal(gated.commands.length,1);gated.advance(1);assert.equal(gated.commands.length,2);
});

test('L: cooldown defaults to ten minutes and validates zero/integer 60000..3600000',()=>{
    const defaults={HttpMode:'certificate-only',AppCommandTimeoutMs:60000,AppCommandKillGraceMs:5000,AppCommandMaxTimeouts:3};
    assert.equal(loadConfig('unused',defaults,{}, {readFileSync:()=> '{}'}).AppStartCooldownMs,600000);
    for(const n of [0,60000,3600000]){const h=createHarness({AppStartCooldownMs:n});waiters(h);}
    for(const n of [-1,1,59999,3600001,60000.5,'600000',null])assert.throws(()=>createHarness({AppStartCooldownMs:n}),/Invalid AppStartCooldownMs/);
});
