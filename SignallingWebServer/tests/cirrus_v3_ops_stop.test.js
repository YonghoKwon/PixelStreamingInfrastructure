const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers/cirrus-v3-harness');

function exhaust() {
    const h = createHarness(); const ue = h.streamer();
    ue.close = () => {}; // A still-connected UE after the launcher's STOP commands.
    h.run('stopApp()'); h.complete();
    for (let i = 0; i < 4; i++) { h.advance(15000); h.complete(); }
    return { h, ue };
}

test('STOP retries exhaust after four retries and health/heartbeat report without rearming', () => {
    const { h } = exhaust();
    const state = h.run('getServiceStatus().stopRetry');
    assert.equal(state.state, 'exhausted'); assert.equal(state.attempts, 4);
    assert.equal(state.at, new Date(1060000).toISOString());
    assert.equal(h.commands.length, 5); assert.equal(h.run('stopRetryTimer'), null);
    h.advance(600000); assert.equal(h.commands.length, 5);
    assert.ok(h.logs.some(row => row.name === 'warn' && row.args.join(' ').includes('STOP retries exhausted (4)')));
});

test('new browser clears STOP exhaustion but does not issue another STOP', () => {
    const { h } = exhaust(); h.player(); h.advance(15000);
    assert.equal(h.run('getServiceStatus().stopRetry.state'), 'idle'); assert.equal(h.commands.length, 5);
});

test('observed final UE disconnect clears STOP exhaustion', () => {
    const { h, ue } = exhaust(); ue.finishClose(); h.advance(5000);
    assert.equal(h.run('getServiceStatus().stopRetry.state'), 'idle');
    h.advance(15000); assert.equal(h.commands.length, 5);
});

test('STOP polling with no UE clears status and stops polling', () => {
    const h = createHarness(); const ue = h.streamer(); h.run('stopApp()'); h.complete();
    ue.finishClose(); h.advance(15000);
    assert.equal(h.run('getServiceStatus().stopRetry.state'), 'idle');
    assert.equal(h.run('stopRetryTimer'), null); assert.equal(h.commands.length, 1);
});
