const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers/cirrus-v3-harness');

const starts = h => h.commands.filter(c => /Start_|run\.sh restart/.test(c.command));
const stops = h => h.commands.filter(c => /Stop_|run\.sh stop/.test(c.command));

test('last browser leaves: silent UE is retained without restart until exactly ten minutes', () => {
    const h = createHarness(); const ue = h.streamer(); const browser = h.player();
    ue.message({type:'ping',time:1}); browser.finishClose();
    const deadline = h.run('idleTimerStartTime + APP_IDLE_TIMEOUT_MS');
    h.advance(599999);
    assert.equal(starts(h).length, 0); assert.equal(stops(h).length, 0);
    assert.equal(h.run('idleTimerStartTime + APP_IDLE_TIMEOUT_MS'), deadline);
    assert.equal(ue.readyState, 1);
    assert.equal(h.run('getServiceStatus().streamerHealth.state'), 'stale');
    h.advance(1); assert.equal(stops(h).length, 1); assert.equal(starts(h).length, 0);
});

test('idle UE socket loss cannot cancel the scheduled launcher STOP', () => {
    const h = createHarness(); const ue = h.streamer(); const browser = h.player();
    browser.finishClose(); h.advance(10000); ue.finishClose(); h.advance(589999);
    assert.equal(starts(h).length, 0); assert.equal(stops(h).length, 0);
    assert.equal(h.run('getServiceStatus().streamerHealth.state'), 'disconnected');
    h.advance(1); assert.equal(stops(h).length, 1);
});

test('disconnect during initial launch neither retries startup nor loses the idle STOP', () => {
    const h = createHarness(); const browser = h.player(); h.complete(0); browser.finishClose();
    h.advance(599999); assert.equal(starts(h).length, 1); assert.equal(stops(h).length, 0);
    h.advance(1); assert.equal(stops(h).length, 1);
});

test('partially failed launcher still receives cleanup at the idle deadline', () => {
    const h = createHarness(); const browser = h.player(); h.complete(0, new Error('launcher failed after spawn'));
    browser.finishClose(); h.advance(600000);
    assert.equal(starts(h).length, 1); assert.equal(stops(h).length, 1);
});

test('browser CLOSING is not restart demand even before its close event arrives', () => {
    const h = createHarness(); const ue = h.streamer(); const browser = h.player();
    ue.message({type:'ping',time:1}); browser.close(); h.advance(90000);
    assert.equal(starts(h).length, 0); browser.finishClose();
    h.advance(600000); assert.equal(stops(h).length, 1);
});

test('return within grace cancels old STOP and the next departure gets a new ten minutes', () => {
    const h = createHarness(); const ue = h.streamer(); const first = h.player();
    first.finishClose(); h.advance(540000);
    ue.message({type:'ping',time:1}); const second = h.player();
    h.advance(60001); assert.equal(h.commands.length, 0);
    ue.message({type:'ping',time:2}); second.finishClose(); h.advance(599999);
    assert.equal(stops(h).length, 0); h.advance(1); assert.equal(stops(h).length, 1);
});

test('one remaining browser prevents shutdown even when JSON pings are missing', () => {
    const h = createHarness(); const ue = h.streamer(); const a = h.player(); const b = h.player();
    ue.message({type:'ping',time:1}); a.finishClose(); h.advance(90000);
    assert.equal(starts(h).length, 0); assert.equal(h.run('idleTimerStartTime'), null);
    ue.message({type:'ping',time:2}); b.finishClose(); h.advance(600000);
    assert.equal(starts(h).length, 0); assert.equal(stops(h).length, 1);
});

test('SFU-only connections never demand idle recovery', () => {
    const h = createHarness(); const sfu = h.sfu(); const ue = h.streamer(); const browser = h.player();
    ue.message({type:'ping',time:1}); browser.finishClose(); h.advance(600000);
    assert.equal(starts(h).length, 0); assert.equal(stops(h).length, 1); assert.equal(sfu.readyState, 1);
});

test('active browser with no first JSON ping stays connected without a restart', () => {
    const h = createHarness(); const ue = h.streamer(); const browser = h.player(); h.advance(1800000);
    assert.equal(starts(h).length, 0); assert.equal(stops(h).length, 0);
    assert.equal(ue.readyState, 1); assert.equal(browser.readyState, 1);
});

test('idle monitoring reports fresh pings without resetting the shutdown deadline', () => {
    const h = createHarness(); const ue = h.streamer(); const browser = h.player(); browser.finishClose();
    const deadline = h.run('idleTimerStartTime + APP_IDLE_TIMEOUT_MS');
    for (let i=0;i<19;i++) { ue.message({type:'ping',time:i}); h.advance(30000); }
    assert.equal(h.run('getServiceStatus().streamerHealth.state'), 'healthy');
    assert.equal(h.run('idleTimerStartTime + APP_IDLE_TIMEOUT_MS'), deadline);
    assert.equal(h.commands.length, 0); h.advance(30000); assert.equal(stops(h).length, 1);
});

test('an unused server does not issue a spurious STOP after ten minutes', () => {
    const h = createHarness(); h.advance(600000); assert.equal(h.commands.length, 0);
});

test('return to a silent idle UE reuses it without restarting for stale JSON pings', () => {
    const h = createHarness(); const ue = h.streamer(); const first = h.player();
    ue.message({type:'ping',time:1}); first.finishClose(); h.advance(300000);
    assert.equal(starts(h).length, 0);
    h.player(); h.advance(30000); assert.equal(starts(h).length, 0);
    assert.equal(h.run('idleTimerStartTime'), null);
});

test('completion of an already-requested recovery cannot extend idle grace', () => {
    const h = createHarness(); const ue = h.streamer(); const browser = h.player();
    browser.message({type:'subscribe',streamerId:'A'});
    h.advance(20000); assert.equal(starts(h).length, 1); // Actual offer negotiation timeout, not ping age.
    browser.finishClose(); const deadline = h.run('idleTimerStartTime + APP_IDLE_TIMEOUT_MS');
    h.advance(30000); h.complete(); h.advance(569999);
    assert.equal(starts(h).length, 1); assert.equal(stops(h).length, 0);
    assert.equal(h.run('idleTimerStartTime + APP_IDLE_TIMEOUT_MS'), deadline);
    h.advance(1); assert.equal(stops(h).length, 1);
});

test('normal sixty-second keepalives with scheduler jitter never restart 3D', () => {
    const h = createHarness(); const ue = h.streamer(); const browser = h.player();
    for (let i=0;i<10;i++) { h.advance(61000); ue.message({type:'ping',time:i}); }
    assert.equal(h.commands.length, 0); assert.equal(ue.readyState, 1); assert.equal(browser.readyState, 1);
});

test('established offer/answer signalling survives missing JSON pings then stops at idle expiry', () => {
    const h = createHarness(); const ue = h.streamer(); const browser = h.player();
    const id = h.playerId(browser); browser.message({type:'subscribe',streamerId:'A'});
    ue.message({type:'offer',playerId:id,sdp:'v=0\r\n'});
    browser.message({type:'answer',sdp:'v=0\r\n'});
    h.advance(600000); assert.equal(h.commands.length, 0);
    assert.equal(browser.readyState, 1); assert.equal(ue.readyState, 1);
    browser.finishClose(); h.advance(599999); assert.equal(stops(h).length, 0);
    h.advance(1); assert.equal(stops(h).length, 1); assert.equal(starts(h).length, 0);
});

test('departing browser cancels pending offer recovery without cancelling eventual cleanup', () => {
    const h = createHarness(); h.streamer(); const browser = h.player();
    browser.message({type:'subscribe',streamerId:'A'}); browser.finishClose();
    h.advance(600000); assert.equal(starts(h).length, 0); assert.equal(stops(h).length, 1);
});
