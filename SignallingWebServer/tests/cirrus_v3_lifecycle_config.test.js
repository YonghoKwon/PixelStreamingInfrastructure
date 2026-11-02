const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers/cirrus-v3-harness');
const harness = (config = {}, options = {}) => createHarness(config, { autoOffer: true, ...options });
function viewers(h) { return [h.player(), h.player(), h.player()]; }

test('N-1: omitted lifecycle keys retain defaults with three browsers', () => {
    const h = harness(); viewers(h);
    assert.equal(h.run('config.AppAutoStart'), true);
    assert.equal(h.run('config.AppIdleTimeoutMs'), 600000);
    assert.equal(h.commands.length, 1);
});

test('N-1: idle timeout accepts only zero or integer 60000..86400000', () => {
    for (const value of [0, 60000, 600000, 86400000]) {
        const h = harness({ AppIdleTimeoutMs: value }); viewers(h);
        assert.equal(h.run('config.AppIdleTimeoutMs'), value);
    }
    for (const value of [59999, 86400001, '600000', 1.5, null, false]) {
        assert.throws(() => harness({ AppIdleTimeoutMs: value }), e =>
            e.code === 'INVALID_CONFIG' && e.message.includes('(value omitted)'));
    }
});

test('N-1: boolean config and real yargs CLI false spelling; invalid values rejected', () => {
    const argv = require('yargs/yargs')(['--AppAutoStart=false']).argv;
    for (const options of [{}, { argv }, { argv: { AppAutoStart: 'true' } }]) {
        const h = harness({ AppAutoStart: false }, options); viewers(h);
        assert.equal(h.run('config.AppAutoStart'), options.argv?.AppAutoStart === 'true');
    }
    for (const value of ['yes', 1, 'false', 'true', null, []]) {
        assert.throws(() => harness({ AppAutoStart: value }), e => e.code === 'INVALID_CONFIG');
    }
    for (const value of ['yes', 1, ['false'], null]) {
        assert.throws(() => harness({}, { argv: { AppAutoStart: value } }), e => e.code === 'INVALID_CONFIG');
    }
});

test('N-1: underscore descriptions have no effect and mixed lifecycle mode warns once', () => {
    for (const extra of [{}, { _설명: { AppAutoStart: false, AppIdleTimeoutMs: -1 } }]) {
        const h = harness(extra); const ue = h.streamer(); const people = viewers(h);
        for (const p of people) p.message({ type: 'subscribe', streamerId: 'A' });
        h.advance(0);
        for (const p of people) assert.ok(p.sent.some(m => m.type === 'offer'));
        assert.equal(ue.readyState, 1); assert.equal(h.commands.length, 0);
    }
    const h = harness({ AppAutoStart: false, AppIdleTimeoutMs: 60000 }); viewers(h);
    assert.equal(h.logs.filter(r => r.name === 'warn' && r.args.join(' ').includes('AppAutoStart=false +')).length, 1);
});
