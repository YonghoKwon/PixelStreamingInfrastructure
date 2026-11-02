const assert = require('node:assert/strict');
const { createHarness } = require('./cirrus-v3-harness');

const harness = (config = {}, options = {}) => createHarness(config, { autoOffer: true, closedSendCallback: true, ...options });
const starts = h => h.commands.filter(c => /Start_|run\.sh restart/.test(c.command));
const stops = h => h.commands.filter(c => /Stop_|run\.sh stop/.test(c.command));
function completePending(h) {
    for (let i = 0; i < h.commands.length; i++) if (!h.commands[i].done) h.complete(i);
}
function viewers(h, count = 3) { return Array.from({ length: count }, () => h.player()); }
function subscribe(h, people, id = 'A') {
    for (const p of people) p.message({ type: 'subscribe', streamerId: id });
    h.advance(0);
    for (const p of people) assert.ok(p.sent.some(m => m.type === 'offer'));
}
// Zero-viewer deadline cases also exercise a real multi-viewer negotiation phase.
function multiRecovery(h) {
    completePending(h);
    const ue = h.streamer(); const people = viewers(h);
    completePending(h); subscribe(h, people);
    for (const p of people) assert.equal(p.readyState, 1);
    assert.equal(ue.readyState, 1);
    return { ue, people };
}
function exhaust(h = harness()) {
    const ue = h.streamer(); const people = viewers(h);
    subscribe(h, people); ue.close = () => {}; // STOP cannot terminate the external UE.
    for (const p of people) p.finishClose();
    h.advance(600000); h.complete();
    for (let i = 0; i < 4; i++) { h.advance(15000); h.complete(); }
    assert.equal(h.run('stopRetryStatus.state'), 'exhausted');
    assert.equal(stops(h).length, 5); // Initial STOP plus four retries.
    return { h, ue };
}
module.exports = { harness, starts, stops, completePending, viewers, subscribe, multiRecovery, exhaust };
