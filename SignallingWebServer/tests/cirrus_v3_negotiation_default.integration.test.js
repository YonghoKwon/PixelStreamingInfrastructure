const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {start,socket,until,pause}=require('./helpers/cirrus-ops-server');

test('F6 real Node process uses the omitted production default1000 for three viewers, not the legacy VM fixture',async()=>{
    // Undefined overrides the helper's legacy0 and is omitted by JSON.stringify.
    // The real cirrus.js process must therefore apply its own production default.
    const s=await start({AppAutoStart:false,AppIdleTimeoutMs:0,PlayerNegotiationGapMs:undefined},{renamed:true});
    try{
        const config=JSON.parse(fs.readFileSync(path.join(s.dir,'config.json'),'utf8'));
        assert.equal(Object.hasOwn(config,'PlayerNegotiationGapMs'),false);
        assert.match(s.logs,/"PlayerNegotiationGapMs":\s*1000/);
        const ue=await socket(s,s.config.StreamerPort),connected=[],answers=[];
        ue.on('message',raw=>{const m=JSON.parse(String(raw));if(m.type==='playerConnected'){connected.push({id:m.playerId,at:Date.now()});ue.send(JSON.stringify({type:'offer',playerId:m.playerId,sdp:'v=0\r\n'}));}if(m.type==='answer')answers.push({id:m.playerId,at:Date.now()});});
        ue.send(JSON.stringify({type:'endpointId',id:'default-gap-UE'}));
        await until(()=>s.logs.includes('Registered new streamer: default-gap-UE'));
        const viewers=[];for(let i=0;i<3;i++)viewers.push(await socket(s,s.config.HttpPort));
        // Distinct TCP sockets do not preserve cross-socket send order. Admit
        // each subscription before sending the next; all remain queued until
        // the first answer below. Assertion values stay deterministic.
        for(let i=0;i<viewers.length;i++){
            viewers[i].send(JSON.stringify({type:'subscribe',streamerId:'default-gap-UE'}));
            await until(()=>s.logs.replace(/\x1b\[[0-9;]*m/g,'').includes(`${i+1} -> subscribe`));
        }
        for(let i=0;i<3;i++){
            await until(()=>connected.length===i+1&&viewers[i].rows.some(m=>m.type==='offer'));
            if(i>0){assert.equal(connected[i].id,String(i+1));assert.ok(connected[i].at-answers[i-1].at>=900,'production default gap must be about1000ms');}
            if(i<2){await pause(100);assert.equal(connected.length,i+1,'next player must wait for this answer');}
            viewers[i].send(JSON.stringify({type:'answer',sdp:'v=0\r\n'}));
            await until(()=>answers.length===i+1);
        }
        assert.equal(connected.length,3);assert.ok(!fs.existsSync(path.join(s.dir,'launches.txt')));
        for(const p of viewers)assert.equal(p.readyState,1);
    }finally{await s.close();}
});
