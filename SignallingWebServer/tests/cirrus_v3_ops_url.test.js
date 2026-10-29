const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers/cirrus-v3-harness');

test('WHATWG URL retains OfferToReceive semantics including empty/case/duplicate values', () => {
    const h = createHarness(); h.streamer();
    const cases = [ ['/', false], ['/?OfferToReceive', true], ['/?OfferToReceive=', true],
        ['/?OfferToReceive=true', true], ['/?OfferToReceive=false', false],
        ['/?OfferToReceive=False', true], ['/?OfferToReceive=0', true],
        ['/?OfferToReceive=false&OfferToReceive=true', false],
        ['/?x=1&OfferToReceive=%66alse#ignored', false], ['/?offertoreceive=true', false],
        ['http://localhost/?OfferToReceive=true', true] ];
    for (const [url, expected] of cases) {
        const p = h.player(url); const id = h.playerId(p);
        assert.equal(h.run(`players.get(${JSON.stringify(id)}).whoSendsOffer === WhoSendsOffer.Browser`), expected, url);
    }
});

test('malformed player URL is contained before admission or launch', () => {
    const h = createHarness();
    for (const url of ['//[', 'http://[invalid', '//%']) {
        let p; assert.doesNotThrow(() => { p = h.player(url); });
        assert.equal(p.closeCalls.at(-1).code, 1008); assert.equal(h.count(), 0);
    }
    assert.equal(h.commands.length, 0);
});
