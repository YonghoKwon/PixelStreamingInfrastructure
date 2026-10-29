const test=require('node:test');
const assert=require('node:assert/strict');
const {loadConfig}=require('../modules/cirrus-v3-support');
const {createHarness}=require('./helpers/cirrus-v3-harness');
const defaults={HttpMode:'certificate-only',AppCommandTimeoutMs:60000,AppCommandKillGraceMs:5000,AppCommandMaxTimeouts:3};
const load=(file={},cli={})=>loadConfig('fixture',defaults,cli,{readFileSync:()=>JSON.stringify(file)});
function viewers(config={}){const h=createHarness(config);h.streamer();h.player();h.player();return h;}

test('N-1: lifecycle defaults and allowed bounds load for two viewers',()=>{
    for(const value of [0,60000,600000,86400000]){
        const h=viewers({AppIdleTimeoutMs:value});assert.equal(h.run('config.AppIdleTimeoutMs'),value);assert.equal(h.count(),2);
    }
    const h=viewers();assert.equal(h.run('config.AppIdleTimeoutMs'),600000);assert.equal(h.run('config.AppAutoStart'),true);
    assert.equal(load().AppIdleTimeoutMs,600000);assert.equal(load().AppAutoStart,true);
});

test('N-1: exact CLI boolean literals normalize; JSON requires real boolean; invalid values are omitted in errors',()=>{
    for(const value of ['true','false',true,false]){
        const config=load({}, {AppAutoStart:value});const h=viewers(config);assert.equal(h.run('config.AppAutoStart'),value===true||value==='true');
    }
    for(const value of [59999,86400001,'600000',1.5,-1,null])assert.throws(()=>load({AppIdleTimeoutMs:value}),e=>e.code==='INVALID_CONFIG'&&e.message.includes('value omitted'));
    for(const value of ['yes','false','true',1,null,[]])assert.throws(()=>load({AppAutoStart:value}),e=>e.code==='INVALID_CONFIG');
    for(const value of ['yes',1,null,[]])assert.throws(()=>load({}, {AppAutoStart:value}),e=>e.code==='INVALID_CONFIG');
});

test('N-1: underscore descriptions neither change two-viewer wire configuration nor recognized options',()=>{
    const plain=viewers(),described=viewers({_설명:'설정 설명',_AppIdleTimeoutMs:1});
    assert.equal(described.count(),2);assert.equal(described.run('config.AppIdleTimeoutMs'),plain.run('config.AppIdleTimeoutMs'));
    assert.equal(described.run('config.AppAutoStart'),plain.run('config.AppAutoStart'));
    assert.equal(described.run('JSON.stringify(clientConfig)'),plain.run('JSON.stringify(clientConfig)'));
});
