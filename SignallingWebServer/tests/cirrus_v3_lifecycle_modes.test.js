const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, starts, stops, viewers, subscribe, multiRecovery } = require('./helpers/cirrus-lifecycle-fixture');
const always = { AppAutoStart: false, AppIdleTimeoutMs: 0 };
function noStarts(h) {
    assert.equal(starts(h).length, 0);
    assert.equal(h.run('startRetryStatus.state'), 'idle');
    assert.equal(h.run('startRetryStatus.attempts'), 0);
    assert.equal(h.run('startRetryTimer'), null);
}

test('N-3 path 1 / (h): three absent-UE viewers and sixty reconnects over two minutes never START', () => {
    const h = harness(always); const people = viewers(h);
    for (let i = 0; i < 60; i++) { const p = h.player(); p.finishClose(); h.advance(2000); }
    noStarts(h); assert.equal(h.count(), 3);
    for (const p of people) assert.equal(p.readyState, 1);
    assert.equal(h.logs.filter(r => r.args.join(' ').includes('START 차단 (browser-start)')).length, 1);
});

test('N-3 path 2: 90-second registration watchdog cannot START with three waiting viewers', () => {
    const h = harness(always); viewers(h);
    // Force the watchdog deadline state; disabled mode never normally creates it.
    h.run('appRunning=true; appStartTime=Date.now(); startStreamerWatchdog()');
    h.advance(120001); noStarts(h); assert.equal(h.count(), 3);
    assert.ok(h.logs.some(r => r.args.join(' ').includes('START 차단 (registration-watchdog)')));
});

test('N-3 path 3 / (i): daily UE restart with two viewers never STARTs; clients resubscribe after list push', () => {
    const h = harness(always); h.streamer(); const people = viewers(h, 2); subscribe(h, people);
    people.forEach(p => assert.ok(p.sent.some(m => m.type === 'offer')));
    h.run('lastStreamerPingTime=Date.now()');
    const oldUE = h.run('streamers.get("A").ws'); oldUE.finishClose();
    // Existing disconnect policy asks browsers to reconnect; emulate that client behavior.
    for (const p of people) { assert.equal(p.readyState, 2); p.finishClose(); }
    const returned = viewers(h, 2); h.advance(5000); noStarts(h);
    h.advance(90000); noStarts(h);
    h.streamer();
    for (const p of returned) assert.ok(p.sent.some(m => m.type === 'streamerList' && m.ids.includes('A')));
    subscribe(h, returned); noStarts(h);
    for (const p of returned) assert.equal(p.readyState, 1);
});

test('N-3 path 4: STOP completion suppresses queued START with three viewers and preserves serialization', () => {
    const h = harness(always); h.streamer(); h.run('stopApp()');
    assert.equal(stops(h).length, 1); const people = viewers(h);
    assert.equal(h.run('startAfterStop'), false);
    h.run('startAfterStop=true'); // Exercise a queued request at the completion boundary as well.
    h.complete(); h.advance(15000); noStarts(h);
    assert.equal(h.run('startAfterStop'), false);
    for (const p of people) assert.equal(p.readyState, 1);
});

test('N-3 path 5 / (j): offer timeout only closes the failed viewer with zero or two negotiated peers', () => {
    for (const healthy of [false, true]) {
        const h = harness(always); const ue = h.streamer(); const people = viewers(h);
        if (healthy) subscribe(h, people.slice(0, 2));
        const failed = people[2]; ue.withheldOfferPlayers.add(h.playerId(failed));
        failed.message({ type: 'subscribe', streamerId: 'A' }); h.advance(0);
        assert.ok(ue.sent.some(m => m.type === 'playerConnected' && m.playerId === h.playerId(failed)));
        h.advance(20000); noStarts(h);
        assert.equal(failed.closeCalls.length, 1);
        assert.deepEqual(failed.closeCalls[0], { code: 1000, reason: '' });
        assert.equal(ue.readyState, 1); assert.equal(ue.closeCalls.length, 0);
        for (const p of people.slice(0, 2)) { assert.equal(p.readyState, 1); assert.equal(p.closeCalls.length, 0); }
        assert.equal(h.logs.filter(r => r.name === 'warn' && r.args.join(' ').includes('START 차단 (offer-timeout)')).length, 1);
    }
});

test('N-3 path 6: slow retry L is unused with three waiting viewers even after 24 virtual hours', () => {
    const h = harness({ ...always, AppStartMaxAttempts: 1, AppStartCooldownMs: 60000 }); viewers(h);
    for (let i = 0; i < 60; i++) h.run('scheduleSlowStartRetry()');
    h.advance(86400000); noStarts(h); assert.equal(h.count(), 3);
    assert.equal(h.run('startRetryStatus.nextRetryAt'), null);
    assert.equal(h.logs.filter(r => r.args.join(' ').includes('START 차단 (slow-retry)')).length, 1);
});

test('N-3: final command-entry guard blocks normal and slow START, while STOP still runs', () => {
    const h = harness(always); const ue = h.streamer(); const people = viewers(h); subscribe(h, people);
    for (let i = 0; i < 60; i++) {
        assert.equal(h.run('runAppCommand(START_CMD, () => {}, false)'), false);
        assert.equal(h.run('runAppCommand(START_CMD, () => {}, true)'), false);
    }
    noStarts(h); assert.equal(h.run('appCommandInProgress'), null);
    assert.equal(h.logs.filter(r => r.args.join(' ').includes('START 차단 (command-entry)')).length, 1);
    for (const p of people) p.finishClose();
    assert.equal(ue.readyState, 1); h.run('stopApp()'); assert.equal(stops(h).length, 1); h.complete(); noStarts(h);
});

test('N-2 / M(g) / (k): idle disabled creates no timer at startup, late UE registration or multi-viewer departure for 24 hours', () => {
    const h = harness({ AppIdleTimeoutMs: 0 });
    assert.equal(h.run('idleTimer'), null); assert.equal(h.run('idleTimerStartTime'), null);
    h.advance(660000); h.streamer(); h.advance(86400000);
    assert.equal(stops(h).length, 0); assert.equal(h.run('idleTimerStartTime'), null);
    const people = viewers(h); subscribe(h, people);
    for (const p of people) p.finishClose();
    h.advance(86400000); assert.equal(stops(h).length, 0);
    assert.equal(h.run('idleTimer'), null); assert.equal(h.run('idleTimerStartTime'), null);
    assert.ok(h.logs.some(r => r.args.join(' ').includes('유휴: 자동 종료 꺼짐')));
});

test('N(l): auto START disabled still allows external UE idle STOP at sixty seconds and three viewers cannot START', () => {
    const h = harness({ AppAutoStart: false, AppIdleTimeoutMs: 60000 }); h.streamer();
    h.advance(59999); assert.equal(stops(h).length, 0);
    h.advance(1); assert.equal(stops(h).length, 1); h.complete();
    const people = viewers(h); noStarts(h);
    for (const p of people) assert.equal(p.readyState, 1);
    multiRecovery(h); noStarts(h);
});

test('N-4: both modes expose lifecycle and heartbeat without changing three-viewer readiness rules', () => {
    for (const config of [{}, always]) {
        const h = harness(config); const mode = config.AppAutoStart === false ? '상시(자동기동 끔)' : '접속 시 기동';
        assert.equal(h.run('getServiceStatus().ready'), false);
        assert.equal(h.run('getServiceStatus().lifecycle.autoStart'), config.AppAutoStart ?? true);
        assert.equal(h.run('getServiceStatus().lifecycle.idleTimeoutMs'), config.AppIdleTimeoutMs ?? 600000);
        h.streamer(); const people = viewers(h); subscribe(h, people); h.advance(30000);
        assert.equal(h.run('getServiceStatus().ready'), true);
        assert.ok(h.logs.some(r => r.args.join(' ').includes(`HEARTBEAT | 모드: ${mode}`)));
        assert.equal(h.logs.filter(r => r.args.join(' ').startsWith('[APP] 모드:')).length, 1);
        h.run('runAppCommand(STOP_CMD, () => {})'); assert.equal(h.run('getServiceStatus().ready'), false);
        h.complete(); assert.equal(h.run('getServiceStatus().ready'), true);
    }
});
