const test=require('node:test');
const assert=require('node:assert/strict');
const {createHarness}=require('./helpers/cirrus-v3-harness');
const {loadConfig}=require('../modules/cirrus-v3-support');
const make=(gap=1000)=>createHarness({AppAutoStart:false,AppIdleTimeoutMs:0,PlayerNegotiationGapMs:gap},{realClosingSend:true});
const connected=ue=>ue.sent.filter(m=>m.type==='playerConnected');
const audience=h=>[h.player(),h.player(),h.player()];
const subscribe=p=>p.message({type:'subscribe',streamerId:'A'});
function offer(h,ue,p){ue.message({type:'offer',playerId:h.playerId(p),sdp:'v=0'});}
function answer(p){p.message({type:'answer',sdp:'v=0'});}

test('F6: three viewers dispatch in order only after answer forwarding and the configured gap',()=>{
    const h=make(),ue=h.streamer(),p=audience(h);p.forEach(subscribe);
    assert.equal(connected(ue).length,1);h.advance(5000);assert.equal(connected(ue).length,1);
    offer(h,ue,p[0]);answer(p[0]);h.advance(999);assert.equal(connected(ue).length,1);
    h.advance(1);assert.equal(connected(ue).length,2);offer(h,ue,p[1]);answer(p[1]);
    h.advance(999);assert.equal(connected(ue).length,2);h.advance(1);
    assert.deepEqual(connected(ue).map(m=>m.playerId),p.map(v=>h.playerId(v)));
});

test('F6: a departing queued viewer is removed without sending a phantom UE disconnect',()=>{
    const h=make(),ue=h.streamer(),[a,b,c]=audience(h);[a,b,c].forEach(subscribe);const bId=h.playerId(b);
    b.finishClose();offer(h,ue,a);answer(a);h.advance(1000);
    assert.deepEqual(connected(ue).map(m=>m.playerId),[h.playerId(a),h.playerId(c)]);
    assert.equal(ue.sent.filter(m=>m.type==='playerDisconnected'&&m.playerId===bId).length,0);
});

test('F6: an active departing viewer releases the next after its disconnect notification',()=>{
    const h=make(),ue=h.streamer(),[a,b,c]=audience(h);[a,b,c].forEach(subscribe);const id=h.playerId(a);
    a.finishClose();h.advance(0);const messages=ue.sent.filter(m=>m.type==='playerConnected'||m.type==='playerDisconnected');
    assert.equal(messages[1].type,'playerDisconnected');assert.equal(messages[1].playerId,id);
    assert.equal(messages[2].type,'playerConnected');assert.equal(messages[2].playerId,h.playerId(b));
});

test('F6: missing answer advances after twenty seconds even when an offer was delivered',()=>{
    const h=make(),ue=h.streamer(),[a,b,c]=audience(h);[a,b,c].forEach(subscribe);offer(h,ue,a);
    h.advance(19999);assert.equal(connected(ue).length,1);h.advance(1);assert.equal(connected(ue).length,2);
    assert.equal(connected(ue)[1].playerId,h.playerId(b));
});

test('F6: a late answer cannot extend the active negotiation beyond its twenty-second cap',()=>{
    const h=make(),ue=h.streamer(),p=audience(h);p.forEach(subscribe);offer(h,ue,p[0]);
    h.advance(19500);answer(p[0]);h.advance(499);assert.equal(connected(ue).length,1);
    h.advance(1);assert.equal(connected(ue).length,2);
});

test('F6: queued viewers have no offer zombie deadline until playerConnected is actually sent',()=>{
    const h=make(),ue=h.streamer(),[a,b,c]=audience(h);[a,b,c].forEach(subscribe);const bId=h.playerId(b);
    assert.equal(h.run(`offerWaitTimers.has(${JSON.stringify(bId)})`),false);offer(h,ue,a);
    h.advance(20000);assert.equal(h.run(`offerWaitTimers.has(${JSON.stringify(bId)})`),true);
    h.advance(19999);assert.equal(b.readyState,1);h.advance(1);assert.equal(b.readyState,2);
    assert.equal(a.readyState,1);assert.equal(ue.readyState,1);assert.equal(h.commands.length,0);
});

test('F6: UE disconnect clears its active queue and timers with no later playerConnected',()=>{
    const h=make(),ue=h.streamer(),p=audience(h);p.forEach(subscribe);assert.equal(connected(ue).length,1);
    ue.finishClose();h.advance(60000);assert.equal(h.run('playerNegotiations.size'),0);
    assert.equal(connected(ue).length,1);assert.equal(h.commands.length,0);
});

test('F6: zero gap retains immediate three-viewer delivery and creates no negotiation queue',()=>{
    const h=make(0),ue=h.streamer(),p=audience(h);p.forEach(subscribe);
    assert.equal(connected(ue).length,3);assert.equal(h.run('playerNegotiations.size'),0);
    assert.equal(h.run('offerWaitTimers.size'),3);
});

test('F6: F7a subscribes all waiters while only the first playerConnected is announced',()=>{
    const h=make(),p=audience(h),ue=h.streamer();h.advance(1000);
    assert.equal(h.logs.filter(l=>l.args.join(' ').includes(' 자동 subscribe → ')).length,3);
    assert.equal(connected(ue).length,1);offer(h,ue,p[0]);answer(p[0]);h.advance(1000);
    offer(h,ue,p[1]);answer(p[1]);h.advance(1000);assert.equal(connected(ue).length,3);
    assert.equal(h.commands.length,0);
});

test('F6: a healthy viewer keeps streaming while a new offer timeout closes only that newcomer',()=>{
    const h=make(),ue=h.streamer(),healthy=h.player();subscribe(healthy);offer(h,ue,healthy);answer(healthy);h.advance(1000);
    const a=h.player(),b=h.player();subscribe(a);subscribe(b);h.advance(20000);
    assert.equal(a.readyState,2);assert.equal(b.readyState,1);assert.equal(healthy.readyState,1);assert.equal(ue.readyState,1);
    assert.equal(h.commands.length,0);
});

test('F6: SFU players and browser-offer viewers keep their existing immediate path',()=>{
    const h=make(),ue=h.streamer(),sfu=h.sfu();sfu.message({type:'subscribe',streamerId:'A'});
    const viewers=[h.player('/?OfferToReceive=true'),h.player('/?OfferToReceive=true')];viewers.forEach(subscribe);
    assert.equal(connected(ue).length,3);assert.equal(h.run('playerNegotiations.size'),0);assert.equal(h.run('offerWaitTimers.size'),0);
});

test('F6: keepalive removes only a non-pong queued viewer without disturbing the active or next viewer',()=>{
    const h=createHarness({AppAutoStart:false,AppIdleTimeoutMs:0,PlayerNegotiationGapMs:1000,PlayerKeepaliveTimeoutMs:5000},{realClosingSend:true});
    const ue=h.streamer(),[a,b,c]=audience(h);[a,b,c].forEach(subscribe);offer(h,ue,a);b.autoPong=false;
    h.advance(10000);assert.equal(b.readyState,3);assert.equal(a.readyState,1);assert.equal(c.readyState,1);
    answer(a);h.advance(1000);assert.deepEqual(connected(ue).map(m=>m.playerId),[h.playerId(a),h.playerId(c)]);
    assert.equal(ue.readyState,1);assert.equal(h.commands.length,0);
});

test('F6: configuration defaults, zero and integer boundaries validate without changing two-viewer admission',()=>{
    const defaults={HttpMode:'web',AppCommandTimeoutMs:60000,AppCommandKillGraceMs:5000,AppCommandMaxTimeouts:3};
    const load=value=>loadConfig('fixture',defaults,{}, {readFileSync:()=>JSON.stringify(value)});
    assert.equal(load({}).PlayerNegotiationGapMs,1000);
    for(const value of[0,100,1000,10000]){assert.equal(load({PlayerNegotiationGapMs:value}).PlayerNegotiationGapMs,value);const h=make(value);h.player();h.player();assert.equal(h.count(),2);}
    for(const value of[-1,1,99,10001,1.5,'1000',null,true])assert.throws(()=>load({PlayerNegotiationGapMs:value}),e=>e.code==='INVALID_CONFIG'&&e.message.includes('value omitted'));
});
