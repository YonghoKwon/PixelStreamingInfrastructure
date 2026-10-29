const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {loadConfig}=require('../modules/cirrus-v3-support');
const {createHarness}=require('./helpers/cirrus-v3-harness');
const defaults={HttpMode:'certificate-only',AppCommandTimeoutMs:60000,AppCommandKillGraceMs:5000,AppCommandMaxTimeouts:3};
const load=name=>loadConfig(path.resolve(__dirname,'../config.'+name+'.example.json'),defaults,{});

test('O: on-demand example loads with visible descriptions and manages three viewers using the default ten minutes',()=>{
    const config=load('on-demand');assert.equal(config.AppAutoStart,true);assert.equal(config.AppIdleTimeoutMs,600000);
    const base=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../config.json'),'utf8'));
    for(const [key,value]of Object.entries(base))assert.deepEqual(config[key],value);
    for(const [key,value]of Object.entries(config).filter(([k])=>k.startsWith('_')))assert.ok(!/password|secret|token|credential|key/i.test(key+value));
    const h=createHarness(config);const viewers=[h.player(),h.player(),h.player()];assert.equal(h.commands.length,1);h.complete();h.streamer();
    for(const p of viewers)p.finishClose();h.advance(599999);assert.equal(h.commands.length,1);h.advance(1);assert.equal(h.commands.length,2);assert.match(h.commands[1].command,/Stop_/);
});

test('O: always-on example loads and leaves all three viewers plus external UE outside automatic START/STOP control',()=>{
    const config=load('always-on');assert.equal(config.AppAutoStart,false);assert.equal(config.AppIdleTimeoutMs,0);
    for(const [key,value]of Object.entries(config).filter(([k])=>k.startsWith('_')))assert.ok(!/password|secret|token|credential|key/i.test(key+value));
    const h=createHarness(config);const viewers=[h.player(),h.player(),h.player()];assert.equal(h.commands.length,0);const ue=h.streamer();
    for(const p of viewers){p.message({type:'subscribe',streamerId:'A'});ue.message({type:'offer',playerId:h.playerId(p),sdp:'v=0'});assert.equal(p.sent.at(-1).type,'offer');}
    for(const p of viewers)p.finishClose();h.advance(600001);assert.equal(h.commands.length,0);assert.equal(ue.readyState,1);assert.equal(h.run('idleTimerStartTime'),null);
});
