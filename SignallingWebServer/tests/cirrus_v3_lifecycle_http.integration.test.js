const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {start,socket,get,until}=require('./helpers/cirrus-ops-server');

test('N CLI: renamed cirrus.js --AppAutoStart=false overrides JSON and three real sockets wait for external UE',async()=>{
    const s=await start({AppAutoStart:true,AppIdleTimeoutMs:0},{renamed:true,cli:['--AppAutoStart=false']});
    try{
        const viewers=[];for(let i=0;i<3;i++)viewers.push(await socket(s,s.config.HttpPort));
        await until(()=>s.logs.includes('player 3'));
        const waiting=await get(s,'/healthz');assert.equal(waiting.body.lifecycle.autoStart,false);assert.equal(waiting.body.lifecycle.idleTimeoutMs,0);
        assert.equal((await get(s,'/readyz')).status,503);assert.ok(!fs.existsSync(path.join(s.dir,'launches.txt')));
        const ue=await socket(s,s.config.StreamerPort);ue.send(JSON.stringify({type:'endpointId',id:'external-UE'}));
        await until(()=>viewers.every(p=>p.rows.some(m=>m.type==='streamerList'&&m.ids.includes('external-UE'))));
        for(const p of viewers)p.send(JSON.stringify({type:'subscribe',streamerId:'external-UE'}));
        await until(()=>ue.rows.filter(m=>m.type==='playerConnected').length===3);
        for(const m of ue.rows.filter(m=>m.type==='playerConnected'))ue.send(JSON.stringify({type:'offer',playerId:m.playerId,sdp:'v=0\r\n'}));
        await until(()=>viewers.every(p=>p.rows.some(m=>m.type==='offer')));
        assert.equal((await get(s,'/readyz')).status,200);assert.ok(!fs.existsSync(path.join(s.dir,'launches.txt')));
        for(const p of viewers)assert.equal(p.readyState,1);
    }finally{await s.close();}
});
