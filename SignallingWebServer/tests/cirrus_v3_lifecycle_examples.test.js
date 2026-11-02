const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../modules/cirrus-v3-support');
const { harness, starts, stops, viewers, subscribe } = require('./helpers/cirrus-lifecycle-fixture');
const defaults = { HttpMode: 'certificate-only', AppCommandTimeoutMs: 60000, AppCommandKillGraceMs: 5000, AppCommandMaxTimeouts: 3 };

for (const [mode, auto, idle] of [['on-demand', true, 600000], ['always-on', false, 0]]) {
    test(`O: ${mode} example loads unchanged base config and manages three viewers in its mode`, () => {
        const base = path.resolve(__dirname, '..');
        const file = path.join(base, `config.${mode}.example.json`);
        const config = loadConfig(file, defaults, {});
        const original = JSON.parse(fs.readFileSync(path.join(base, 'config.json'), 'utf8'));
        for (const [key, value] of Object.entries(original)) assert.deepEqual(config[key], value);
        assert.equal(config.AppAutoStart, auto); assert.equal(config.AppIdleTimeoutMs, idle);
        const descriptions = Object.entries(config).filter(([key]) => key.startsWith('_'));
        assert.equal(descriptions.length, 3);
        assert.ok(config._운영모드.includes(auto ? '접속 시 기동' : '상시 운영'));
        assert.ok(config._설명_AppIdleTimeoutMs.includes('10분'));
        assert.ok(config._설명_AppAutoStart.includes('켜지 않음'));
        for (const [key, value] of descriptions) assert.doesNotMatch(key + value, /password|secret|token|credential|key/i);
        const h = harness(config); const people = viewers(h);
        assert.equal(starts(h).length, auto ? 1 : 0); if (auto) h.complete();
        h.streamer();
        for (const p of people) assert.ok(p.sent.some(m => m.type === 'streamerList' && m.ids.includes('A')));
        subscribe(h, people);
        for (const p of people) p.finishClose();
        h.advance(599999); assert.equal(stops(h).length, 0);
        h.advance(1); assert.equal(stops(h).length, auto ? 1 : 0);
        assert.equal(h.run('getServiceStatus().lifecycle.autoStart'), auto);
        assert.equal(h.run('getServiceStatus().lifecycle.idleTimeoutMs'), idle);
    });
}
