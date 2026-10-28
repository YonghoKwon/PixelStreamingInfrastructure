const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers/cirrus-v3-harness');
const { closeReason } = require('../modules/cirrus-v3-support');

test('disconnectPlayer bounds Korean/emoji reasons at UTF-8 character boundaries', () => {
    const h = createHarness(); const ue = h.streamer(); const p = h.player();
    const reason = '한글😀'.repeat(100);
    ue.message({ type: 'disconnectPlayer', playerId: h.playerId(p), reason });
    const closed = p.closeCalls.at(-1);
    assert.equal(closed.code, 1011); assert.ok(Buffer.byteLength(closed.reason) <= 123);
    assert.ok(reason.startsWith(closed.reason));
    assert.equal(Buffer.from(closed.reason).toString(), closed.reason);
    assert.equal(ue.readyState, 1);
});

test('disconnectPlayer accepts an object reason and retains the UE socket', () => {
    const h = createHarness(); const ue = h.streamer(); const p = h.player();
    ue.message({ type: 'disconnectPlayer', playerId: h.playerId(p), reason: { message: '종료' } });
    assert.equal(p.closeCalls.at(-1).reason, '[object Object]'); assert.equal(ue.readyState, 1);
    assert.equal(closeReason(null), '');
    assert.equal(closeReason({ toString() { throw Error('conversion'); } }), 'Invalid disconnect reason');
});

test('throwing UE handlers keep UE open while player/SFU handlers close only their sender', async () => {
    const h = createHarness(); const ue = h.streamer(); const p = h.player(); const sfu = h.sfu();
    h.run("streamerMessageHandlers.set('throwTest', () => { throw Error('UE handler test'); })");
    h.run("playerMessageHandlers.set('throwTest', () => { throw Error('player handler test'); })");
    h.run("sfuMessageHandlers.set('throwTest', () => Promise.reject(Error('SFU handler test')))");
    ue.message({ type: 'throwTest' }); p.message({ type: 'throwTest' }); sfu.message({ type: 'throwTest' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ue.readyState, 1); assert.equal(h.run('appStreamerCount(true)'), 1);
    assert.equal(p.closeCalls.at(-1).code, 1011); assert.equal(sfu.closeCalls.at(-1).code, 1011);
    assert.ok(h.logs.some(row => row.name === 'error' && row.args.join(' ').includes('UE handler test')));
});

test('rejected UE handler promises and thrown null are contained without disconnecting UE', async () => {
    const h = createHarness(); const ue = h.streamer();
    h.run("streamerMessageHandlers.set('rejectTest', () => Promise.reject(Error('UE async test')))");
    ue.message({ type: 'rejectTest' });
    h.run("streamerMessageHandlers.set('nullTest', () => { throw null; })");
    ue.message({ type: 'nullTest' }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(ue.closeCalls.length, 0); assert.equal(ue.readyState, 1);
});
