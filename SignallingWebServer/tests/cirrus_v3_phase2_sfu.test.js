const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers/cirrus-v3-harness');

test('R1: subscribed SFU startStreaming with registered UE renews START budget with multiple browsers', () => {
    const h = createHarness({ AppStartMaxAttempts: 1 });
    const viewers = [h.player(), h.player(), h.player()]; h.complete();
    const ue = h.streamer(); const sfu = h.sfu();
    sfu.message({ type: 'subscribe', streamerId: 'A' });
    assert.equal(h.run('startRetryStatus.state'), 'exhausted');
    sfu.message({ type: 'startStreaming' });
    assert.equal(h.run('startRetryStatus.state'), 'idle'); assert.equal(h.run('startRetryStatus.attempts'), 0);
    assert.equal(ue.readyState, 1); for (const p of viewers) assert.equal(p.readyState, 1);
});

test('R1: SFU-only/unsubscribed or closed UE cannot renew budget for waiting viewers', () => {
    for (const scenario of ['noUE', 'unsubscribed', 'closed']) {
        const h = createHarness({ AppStartMaxAttempts: 1 }); h.player(); h.player(); h.complete();
        const ue = scenario === 'noUE' ? null : h.streamer(); const sfu = h.sfu();
        if (scenario === 'closed') { sfu.message({ type: 'subscribe', streamerId: 'A' }); ue.close(); }
        sfu.message({ type: 'startStreaming' });
        assert.equal(h.run('startRetryStatus.state'), 'exhausted', scenario);
    }
});
