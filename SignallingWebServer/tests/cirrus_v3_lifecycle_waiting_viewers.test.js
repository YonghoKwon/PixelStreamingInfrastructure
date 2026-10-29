const test=require('node:test');
const assert=require('node:assert/strict');
const {createHarness}=require('./helpers/cirrus-v3-harness');
const make=(autoStart=false)=>createHarness({AppAutoStart:autoStart,AppIdleTimeoutMs:0},{realClosingSend:true});
const audience=h=>[h.player(),h.player(),h.player()];
const connected=ue=>ue.sent.filter(m=>m.type==='playerConnected');
const automatic=h=>h.logs.filter(l=>l.args.join(' ').includes(' 자동 subscribe → '));
const subscribed=(h,p)=>h.run(`players.get(${JSON.stringify(h.playerId(p))}).streamerId`);

for(const autoStart of [false,true])test(`F7a(a): all three waiting viewers auto-subscribe after one second, autoStart=${autoStart}`,()=>{
    const h=make(autoStart),viewers=audience(h);if(autoStart)h.complete();const ue=h.streamer();
    for(const p of viewers)assert.ok(p.sent.some(m=>m.type==='streamerList'&&m.ids.includes('A')));
    h.advance(999);assert.equal(connected(ue).length,0);h.advance(1);
    assert.equal(connected(ue).length,3);assert.equal(automatic(h).length,3);
    for(const p of viewers)assert.equal(subscribed(h,p),'A');
});

test('F7a(b): a viewer selecting within half a second is never subscribed twice',()=>{
    const h=make(),[a,b,c]=audience(h),ue=h.streamer();h.advance(500);
    a.message({type:'subscribe',streamerId:'A'});h.advance(500);
    assert.equal(connected(ue).length,3);assert.equal(automatic(h).length,2);
    for(const p of[a,b,c])assert.equal(connected(ue).filter(m=>m.playerId===h.playerId(p)).length,1);
});

test('F7a(c): a closing socket still present in players is skipped while two open viewers subscribe',()=>{
    const h=make(),[a,b,c]=audience(h),ue=h.streamer();h.advance(500);c.close();h.advance(500);
    assert.equal(connected(ue).length,2);assert.equal(automatic(h).length,2);
    assert.equal(subscribed(h,c),undefined);assert.equal(subscribed(h,a),'A');assert.equal(subscribed(h,b),'A');
});

test('F7a(c identity): a replacement player object with the same ID cannot inherit the scheduled subscription',()=>{
    const h=make(),[a,b,c]=audience(h),ue=h.streamer();h.advance(500);
    h.run(`var oldWaitingPlayer=players.get(${JSON.stringify(h.playerId(c))});players.set(oldWaitingPlayer.id,Object.create(oldWaitingPlayer));`);
    h.advance(500);assert.equal(connected(ue).length,2);assert.equal(automatic(h).length,2);
    assert.equal(subscribed(h,c),undefined);assert.equal(subscribed(h,a),'A');assert.equal(subscribed(h,b),'A');
});

test('F7a(d): a disconnected UE gets no delayed playerConnected messages',()=>{
    const h=make();audience(h);const ue=h.streamer();h.advance(500);ue.finishClose();h.advance(500);
    assert.equal(connected(ue).length,0);assert.equal(automatic(h).length,0);
});

test('F7a(d replacement): old-instance deadline does nothing; replacement registration has its own one-second deadline',()=>{
    const h=make(),viewers=audience(h),old=h.streamer();h.advance(500);const replacement=h.streamer();
    h.advance(500);assert.equal(connected(old).length,0);assert.equal(connected(replacement).length,0);assert.equal(automatic(h).length,0);
    h.advance(500);assert.equal(connected(replacement).length,3);assert.equal(automatic(h).length,3);
    for(const p of viewers)assert.equal(subscribed(h,p),'A');
});

test('F7a(e): two registered streamers prevent both registration and stale single-streamer callbacks from selecting one',()=>{
    const h=make();audience(h);const a=h.streamer('A');h.advance(500);const b=h.streamer('B');h.advance(1000);
    assert.equal(connected(a).length,0);assert.equal(connected(b).length,0);assert.equal(automatic(h).length,0);
});

test('F7a(f): SFU player is excluded while all three regular waiters subscribe',()=>{
    const h=make(),sfu=h.sfu();audience(h);const ue=h.streamer();h.advance(1000);
    assert.equal(connected(ue).length,3);assert.ok(connected(ue).every(m=>m.sfu===false));
    assert.equal(automatic(h).length,3);assert.equal(sfu.readyState,1);
});

test('F7a(f registration): publishing an SFU alone never auto-subscribes three regular waiters',()=>{
    const h=make(),sfu=h.sfu();audience(h);sfu.message({type:'startStreaming'});h.advance(1000);
    assert.equal(automatic(h).length,0);assert.equal(connected(sfu).length,0);
});

test('F7a(g): a single waiter retains the exact log and one-second subscription result',()=>{
    const h=make(),p=h.player(),ue=h.streamer();h.advance(999);assert.equal(connected(ue).length,0);
    h.advance(1);assert.equal(connected(ue).length,1);assert.equal(automatic(h).length,1);
    assert.ok(automatic(h)[0].args.includes(`[STREAMER] 대기 플레이어 ${h.playerId(p)} 자동 subscribe → A`));
});

test('F7a(h): two always-on viewers recover offers after external restart without sending subscribe or issuing START',()=>{
    const h=make(),ue=h.streamer(),old=[h.player(),h.player()];
    for(const p of old){p.message({type:'subscribe',streamerId:'A'});ue.message({type:'offer',playerId:h.playerId(p),sdp:'before'});}
    ue.finishClose();for(const p of old)p.finishClose();const viewers=[h.player(),h.player()];h.advance(60000);
    const replacement=h.streamer();h.advance(1000);assert.equal(connected(replacement).length,2);
    for(const p of viewers){replacement.message({type:'offer',playerId:h.playerId(p),sdp:'after external restart'});assert.equal(p.sent.at(-1).sdp,'after external restart');}
    assert.equal(h.commands.filter(c=>/Start_|run\.sh restart/.test(c.command)).length,0);
});
