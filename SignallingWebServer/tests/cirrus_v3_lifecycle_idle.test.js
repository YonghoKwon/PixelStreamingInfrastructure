const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, starts, stops, viewers, subscribe, multiRecovery, exhaust } = require('./helpers/cirrus-lifecycle-fixture');

test('M(a): standalone UE at minute 11 gets ten minutes from registration then three viewers recover', () => {
    const h = harness(); h.advance(660000); h.streamer();
    h.advance(599999); assert.equal(stops(h).length, 0);
    h.advance(1); assert.equal(stops(h).length, 1); multiRecovery(h);
});

test('M(b): standalone UE at minute 9 stops at minute 19, not minute 10; multi-viewer recovery', () => {
    const h = harness(); h.advance(540000); h.streamer();
    h.advance(60000); assert.equal(stops(h).length, 0);
    h.advance(539999); assert.equal(stops(h).length, 0);
    h.advance(1); assert.equal(stops(h).length, 1); multiRecovery(h);
});

test('M(c): three waiting viewers prevent registration timer; last departure owns deadline', () => {
    const h = harness(); const people = viewers(h); h.complete(); h.streamer(); subscribe(h, people);
    assert.equal(h.run('idleTimerStartTime'), null);
    people[0].finishClose(); people[1].finishClose(); h.advance(600000);
    assert.equal(stops(h).length, 0); people[2].finishClose();
    h.advance(599999); assert.equal(stops(h).length, 0);
    h.advance(1); assert.equal(stops(h).length, 1);
});

test('M(d): three viewers at registration plus five minutes cancel the standalone timer', () => {
    const h = harness(); h.streamer(); h.advance(300000);
    const people = viewers(h); subscribe(h, people); h.advance(900000);
    assert.equal(stops(h).length, 0); assert.equal(h.run('idleTimerStartTime'), null);
    for (const p of people) assert.equal(p.readyState, 1);
});

test('M(e): SFU does not rearm expired startup idle timer; three UE viewers still negotiate', () => {
    const h = harness(); h.advance(660000); const before = h.run('idleTimerStartTime'); h.sfu();
    assert.equal(h.run('idleTimerStartTime'), before); assert.equal(h.run('appRunning'), false);
    h.advance(600000); assert.equal(stops(h).length, 0); multiRecovery(h);
});

test('M(f): same-ID UE replacement with three subscribed viewers never starts idle shutdown', () => {
    const h = harness(); h.streamer(); const people = viewers(h); subscribe(h, people);
    const replacement = h.streamer();
    assert.equal(h.run('idleTimerStartTime'), null); h.advance(1200000);
    assert.equal(stops(h).length, 0); assert.equal(replacement.readyState, 1);
    // Existing same-ID replacement closes subscribers to invite reconnection.
    for (const p of people) assert.equal(p.readyState, 2);
    assert.equal(starts(h).length, 0);
});

test('M: STOP command, launcher blocked, and zombie restart each suppress registration timer', () => {
    for (const state of ['stop', 'blocked', 'zombie']) {
        const h = harness(); h.run('resetIdleTimer()');
        if (state === 'stop') h.run('runAppCommand(STOP_CMD, () => {})');
        if (state === 'blocked') h.run('appCommandRunner.isBlocked = () => true');
        if (state === 'zombie') h.run('zombieRestartInProgress = true');
        h.streamer(); assert.equal(h.run('idleTimerStartTime'), null);
        if (state === 'stop') h.complete();
        if (state === 'blocked') h.run('appCommandRunner.isBlocked = () => false');
        if (state === 'zombie') h.run('zombieRestartInProgress = false');
        multiRecovery(h);
    }
});

test('R1/R2(a): UE re-registration during STOP retry leaves idle timer unarmed', () => {
    const h = harness(); h.streamer(); const people = viewers(h); subscribe(h, people);
    for (const p of people) p.finishClose();
    h.advance(600000); h.complete(); const before = h.run('idleTimerStartTime');
    assert.ok(h.run('stopRetryTimer')); h.streamer();
    assert.equal(h.run('idleTimerStartTime'), before);
    h.advance(15000); assert.equal(stops(h).length, 2);
});

test('R1/R2(b): exhausted STOP survives final forced socket loss and 3-second reconnect for 30 minutes', () => {
    const { h, ue } = exhaust(); ue.finishClose();
    assert.equal(h.run('stopRetryStatus.state'), 'exhausted'); h.advance(3000); h.streamer();
    h.advance(1800000); assert.equal(h.run('stopRetryStatus.state'), 'exhausted');
    assert.equal(stops(h).length, 5); assert.equal(h.run('stopRetryTimer'), null);
});

test('R1/R2(c): only five seconds with no UE clears exhaustion; next standalone UE uses M', () => {
    const { h, ue } = exhaust(); ue.finishClose(); h.advance(4999);
    assert.equal(h.run('stopRetryStatus.state'), 'exhausted'); h.advance(1);
    assert.equal(h.run('stopRetryStatus.state'), 'idle'); h.streamer();
    h.advance(599999); assert.equal(stops(h).length, 5);
    h.advance(1); assert.equal(stops(h).length, 6);
});

test('R1/R2(d): three browsers clear exhaustion and their last departure restores idle shutdown', () => {
    const { h } = exhaust(); const people = viewers(h); subscribe(h, people);
    assert.equal(h.run('stopRetryStatus.state'), 'idle');
    for (const p of people) p.finishClose();
    h.advance(599999); assert.equal(stops(h).length, 5);
    h.advance(1); assert.equal(stops(h).length, 6);
});

test('R1/R2(e): two viewers clear STOP exhaustion and preserve existing START reuse policy', () => {
    const { h } = exhaust(); const people = viewers(h, 2); subscribe(h, people);
    assert.equal(h.run('stopRetryStatus.state'), 'idle'); assert.equal(starts(h).length, 0);
    h.advance(600000); assert.equal(stops(h).length, 5);
    for (const p of people) assert.equal(p.readyState, 1);
});
