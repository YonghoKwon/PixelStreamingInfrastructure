const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers/cirrus-v3-harness');

test('mDNS missing socket/address or nonstring candidate passes through without closing browser', () => {
    for (const address of [undefined, null, {}, { remoteAddress: '' }, { remoteAddress: 123 }]) {
        const h = createHarness(); const ue = h.streamer(); const p = h.player();
        p.message({ type: 'subscribe', streamerId: 'A' }); p._socket = address;
        for (const candidate of ['candidate:1 host-123.local 99', 13, { address: 'x' }, null]) {
            p.message({ type: 'iceCandidate', candidate: { candidate } });
            assert.deepEqual(ue.sent.at(-1).candidate.candidate, candidate); assert.equal(p.readyState, 1);
        }
    }
});

test('mDNS host is replaced with available browser IP and other ICE content is retained', () => {
    const h = createHarness(); const ue = h.streamer(); const p = h.player();
    p.message({ type: 'subscribe', streamerId: 'A' });
    p.message({ type: 'iceCandidate', candidate: { candidate: 'candidate:1 host-123.local 99', sdpMLineIndex: 0 } });
    assert.equal(ue.sent.at(-1).candidate.candidate, 'candidate:1 127.0.0.1 99');
    assert.equal(ue.sent.at(-1).candidate.sdpMLineIndex, 0);
});

test('all three WebSocket listeners bound payloads by default and configured limit', () => {
    for (const value of [undefined, 65536, 104857600]) {
        const h = createHarness(value === undefined ? {} : { MaxWebSocketPayloadBytes: value });
        for (const name of ['playerServer', 'streamerServer', 'sfuServer']) {
            assert.equal(h.run(`${name}.options.maxPayload`), value ?? 4194304);
        }
    }
});

test('payload config rejects nonintegers and out-of-range inputs without echoing values', () => {
    for (const value of [65535, 104857601, 65536.5, '65536', null]) {
        assert.throws(() => createHarness({ MaxWebSocketPayloadBytes: value }), /Invalid MaxWebSocketPayloadBytes/);
    }
});
