const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness } = require('./helpers/cirrus-v3-harness');

function advanceWithPings(h, streamer, milliseconds) {
    while (milliseconds > 0) {
        streamer.message({ type: 'ping', time: 1 });
        const step = Math.min(30000, milliseconds);
        h.advance(step);
        milliseconds -= step;
    }
}

test('an unused SFU does not prevent the existing ten-minute idle shutdown', () => {
    const h = createHarness(); const sfu = h.sfu(); const streamer = h.streamer();
    assert.equal(h.count(), 0);
    advanceWithPings(h, streamer, 600000);
    assert.equal(h.commands.length, 1);
    assert.match(h.commands[0].command, /Stop_/);
    assert.equal(sfu.readyState, 1);
});

test('last browser departure starts idle timing while the SFU stays connected', () => {
    const h = createHarness(); h.sfu(); const streamer = h.streamer(); const browser = h.player();
    browser.finishClose(); advanceWithPings(h, streamer, 599999);
    assert.equal(h.commands.length, 0);
    h.advance(1); assert.match(h.commands[0].command, /Stop_/);
});

test('simultaneous arrivals still request just one START', () => {
    const h = createHarness(); h.player(); h.player();
    assert.equal(h.commands.length, 1);
    assert.equal(h.commands[0].options.windowsHide, true); // v3 owns a bounded launcher process.
});

test('unsubscribe cancels the offer timer without changing socket lifetime', () => {
    const h = createHarness(); const streamer = h.streamer(); const browser = h.player();
    browser.message({ type: 'subscribe', streamerId: 'A' });
    browser.message({ type: 'unsubscribe' }); h.advance(20000);
    assert.equal(h.run('offerWaitTimers.size'), 0);
    assert.equal(h.commands.length, 0);
    assert.equal(browser.readyState, 1); assert.equal(streamer.readyState, 1);
});

test('a closing old browser cannot restart its replacement streamer', () => {
    const h = createHarness(); h.streamer(); const browser = h.player();
    browser.message({ type: 'subscribe', streamerId: 'A' });
    const replacement = h.streamer(); h.advance(20000);
    assert.equal(browser.readyState, 2); // Preserve the v1 close handshake; no forced termination.
    assert.equal(h.commands.length, 0); assert.equal(replacement.readyState, 1);
    assert.equal(h.run('offerWaitTimers.size'), 0);
});

test('late JSON pings cannot request a launcher command while the browser remains connected', () => {
    const h = createHarness(); const streamer = h.streamer(); h.player();
    streamer.message({ type: 'ping', time: 1 }); h.advance(90000);
    assert.equal(h.commands.length, 0);
    h.advance(90000); assert.equal(h.commands.length, 0);
});

test('offer timeout defers while an existing START command is running', () => {
    const h = createHarness(); const browser = h.player(); h.streamer();
    browser.message({ type: 'subscribe', streamerId: 'A' }); h.advance(20000);
    assert.equal(h.commands.length, 1); assert.equal(h.run('offerWaitTimers.size'), 1);
    h.complete(0); h.advance(20000); assert.equal(h.commands.length, 2);
});

test('a browser arriving during STOP is started only after STOP completion', () => {
    const h = createHarness(); h.streamer(); h.run('stopApp()'); h.player();
    h.advance(15000); assert.equal(h.commands.length, 1);
    assert.equal(h.run('stopRetryTimer'), null);
    h.complete(0); assert.equal(h.commands.length, 2);
    assert.match(h.commands[0].command, /Stop_/); assert.match(h.commands[1].command, /Start_/);
});

test('new arrivals cancel STOP retries even when an open streamer causes early return', () => {
    const h = createHarness(); h.streamer(); h.run('stopApp()'); h.complete();
    h.streamer(); h.player(); h.advance(15000);
    assert.equal(h.commands.filter(command => /Stop_/.test(command.command)).length, 1);
    assert.equal(h.run('stopRetryTimer'), null);
});

test('stop retry callback rechecks browser demand before executing STOP', () => {
    const h = createHarness(); h.streamer(); h.run('stopApp()'); h.complete();
    // Model an admitted browser before its startApp callback has cancelled the interval.
    h.run('players.set("late", new Player("late", {readyState:1,send(){}}, PlayerType.Regular, WhoSendsOffer.Streamer))');
    h.advance(15000);
    assert.equal(h.commands.length, 1); assert.equal(h.run('stopRetryTimer'), null);
});

test('queued idle shutdown waits for START and is cancelled by a new browser', () => {
    for (const newBrowser of [false, true]) {
        const h = createHarness(); const browser = h.player(); browser.finishClose(); h.run('stopApp()');
        if (newBrowser) h.player();
        assert.equal(h.commands.length, 1); h.complete(0);
        assert.equal(h.commands.length, newBrowser ? 1 : 2);
        if (!newBrowser) assert.match(h.commands[1].command, /Stop_/);
    }
});

test('a failed START retries on the existing 90-second/30-second watchdog schedule', () => {
    const h = createHarness(); h.player(); h.complete(0, new Error('start failed'));
    h.advance(90000); assert.equal(h.commands.length, 1);
    h.advance(30000); assert.equal(h.commands.length, 2);
});

test('a successful command with no UE registration is still retried', () => {
    const h = createHarness(); h.player(); h.complete(0); h.advance(120000);
    assert.equal(h.commands.length, 2);
});

test('zombie restart also starts the existing registration watchdog', () => {
    const h = createHarness(); h.streamer(); const browser = h.player();
    browser.message({ type: 'subscribe', streamerId: 'A' }); h.advance(20000);
    assert.equal(h.commands.length, 1);
    browser.finishClose(); h.player(); h.complete(0); h.advance(120000);
    assert.equal(h.commands.length, 2);
});

test('SFU registration cannot complete UE startup or cancel its missing-streamer timer', () => {
    const h = createHarness(); h.player(); const sfu = h.sfu();
    sfu.message({ type: 'startStreaming' });
    assert.notEqual(h.run('appStartTime'), null);
    h.complete(0); h.advance(120000); assert.equal(h.commands.length, 2);
});

test('SFU connectivity alone is not demand for startup retries', () => {
    const h = createHarness(); h.sfu(); const browser = h.player(); browser.finishClose();
    h.complete(0, new Error('start failed')); h.advance(180000);
    assert.equal(h.commands.length, 1);
});

test('a late launcher error does not mark a registered UE as stopped', () => {
    const h = createHarness(); h.player(); h.streamer(); h.complete(0, new Error('late launcher error'));
    assert.equal(h.run('appRunning'), true);
});

test('same-socket endpointId and repeated subscribe are idempotent', () => {
    const h = createHarness(); const streamer = h.streamer(); const browser = h.player();
    browser.message({ type: 'subscribe', streamerId: 'A' });
    browser.message({ type: 'subscribe', streamerId: 'A' });
    streamer.message({ type: 'endpointId', id: 'A' });
    assert.equal(streamer.readyState, 1); assert.equal(browser.readyState, 1);
    assert.equal(streamer.sent.filter(message => message.type === 'playerConnected').length, 1);
});

test('server fallback followed by a late browser subscription remains idempotent', () => {
    const h = createHarness(); const browser = h.player(); const streamer = h.streamer();
    h.advance(1000); browser.message({ type: 'subscribe', streamerId: 'A' });
    assert.equal(streamer.sent.filter(message => message.type === 'playerConnected').length, 1);
});

test('switching subscriptions releases the old streamer and keeps one offer timer', () => {
    const h = createHarness(); const a = h.streamer('A'); const b = h.streamer('B'); const browser = h.player();
    browser.message({ type: 'subscribe', streamerId: 'A' }); browser.message({ type: 'subscribe', streamerId: 'B' });
    assert.equal(a.sent.filter(message => message.type === 'playerDisconnected').length, 1);
    assert.equal(b.sent.filter(message => message.type === 'playerConnected').length, 1);
    assert.equal(h.run('offerWaitTimers.size'), 1);
});

test('delayed old close and repeated browser cleanup preserve v1 protections', () => {
    const h = createHarness(); const old = h.streamer(); const current = h.streamer(); old.finishClose();
    assert.equal(current.readyState, 1); assert.equal(h.run('streamers.size'), 1);
    const browser = h.player(); const id = h.playerId(browser); browser.finishClose();
    assert.doesNotThrow(() => h.run('onPlayerDisconnected(' + JSON.stringify(id) + ')'));
});

test('closing before identification cancels the v1 ID timer', () => {
    const h = createHarness(); const streamer = h.streamer(null); streamer.finishClose(); h.advance(5000);
    assert.equal(h.run('streamers.size'), 0);
});

test('non-object JSON messages close only the offending player using the v1 code', () => {
    for (const payload of ['null', '[]', '5', '{']) {
        const h = createHarness(); h.streamer(); const bad = h.player(); const good = h.player();
        assert.doesNotThrow(() => bad.message(payload));
        assert.equal(bad.closeCalls[0].code, 1008); assert.equal(good.readyState, 1);
        h.advance(30000); assert.equal(bad.terminateCalls, 0);
    }
});

test('sync and async handler failures are isolated without global process handlers', async () => {
    const h = createHarness(); h.streamer(); const first = h.player(); const second = h.player();
    h.run('playerMessageHandlers.set("broken", () => { throw new Error("failure"); })');
    first.message({ type: 'broken' }); assert.equal(first.closeCalls[0].code, 1011); assert.equal(second.readyState, 1);
    h.run('playerMessageHandlers.set("asyncBroken", async () => { throw new Error("failure"); })');
    second.message({ type: 'asyncBroken' }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(second.closeCalls[0].code, 1011);
    assert.equal(h.process.listenerCount('uncaughtException'), 0);
});

test('existing mDNS rewriting and BrowserSendOffer behavior are unchanged', () => {
    const h = createHarness(); const streamer = h.streamer(); const browser = h.player('/?OfferToReceive=true');
    browser.message({ type: 'offer', sdp: 'browser offer' });
    // v1 forwards a browser-first offer directly; it does not synthesize playerConnected here.
    assert.equal(streamer.sent.some(message => message.type === 'playerConnected'), false);
    assert.equal(streamer.sent.find(message => message.type === 'offer').sdp, 'browser offer');
    assert.equal(h.run('offerWaitTimers.size'), 0);
    browser.message({ type: 'iceCandidate', candidate: { candidate: 'candidate:1 1 UDP 1 host.local 50123 typ host' } });
    assert.match(streamer.sent.find(message => message.type === 'iceCandidate').candidate.candidate, /127\.0\.0\.1 50123/);
});

test('production v1 forwarding and shared timings remain; v3 startup retry is explicit', () => {
    const read=file=>fs.readFileSync(path.resolve(__dirname,'..',file),'utf8').replace(/\r\n/g,'\n');
    const baseline=read('cirrus_v1.js'), current=read('cirrus_v3_codex.js');
    const section=source=>source.slice(source.indexOf('function forwardPlayerMessage('),source.indexOf('function onPlayerDisconnected('));
    assert.equal(section(current),section(baseline));
    for(const name of ['OFFER_WAIT_TIMEOUT_MS','STREAMER_PING_TIMEOUT_MS','APP_IDLE_TIMEOUT_MS','STOP_RETRY_INTERVAL_MS','STOP_RETRY_MAX']){
        const expression=new RegExp('^const '+name+' = ([^;]+);','m');
        assert.equal(current.match(expression)[1],baseline.match(expression)[1]);
    }
    assert.equal(/^const APP_START_TIMEOUT_MS = /m.test(baseline), false);
    assert.match(current, /^const APP_START_TIMEOUT_MS = 90 \* 1000;/m);
});

test('START cancels an old missing-streamer timer before the script exits', () => {
    const h = createHarness(); const streamer = h.streamer(); streamer.finishClose();
    h.run('appRunning = false'); h.player(); h.complete(0);
    h.advance(5000);
    assert.equal(h.commands.length, 1); assert.notEqual(h.run('appStartTime'), null);
});

test('closing sockets remain counted until close as in v1, with SFU excluded', () => {
    const h = createHarness(); const sfu = h.sfu(); sfu.message({type:'startStreaming'});
    const streamer = h.streamer(); const browser = h.player();
    streamer.close(); browser.close();
    assert.equal(h.run('appStreamerCount()'), 1);
    assert.equal(h.run('appStreamerCount(true)'), 0);
    assert.equal(h.count(), 1);
    streamer.finishClose(); browser.finishClose();
    assert.equal(h.run('appStreamerCount()'), 0); assert.equal(h.count(), 0);
});
