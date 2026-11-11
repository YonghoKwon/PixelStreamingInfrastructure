'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers/cirrus-v3-harness');
const { nextRestartAt } = require('../modules/cirrus-v3-support');
const ops = require('./helpers/cirrus-ops-server');
const local = (d, h = 0, m = 0) => new Date(2026, 10, d, h, m).getTime();
const create = (config = {}, now = local(9, 0, -1), options = {}) => createHarness({
    AppAutoStart: false, AppIdleTimeoutMs: 0, AppRestartTime: ['00:00', '12:00'], ...config
}, { now, autoOffer: true, closedSendCallback: true, ...options });
const starts = h => h.commands.filter(c => /Start_|restart$/.test(c.command));
const status = h => JSON.parse(h.run('JSON.stringify(getServiceStatus().scheduledRestart)'));
const logs = h => h.logs.map(r => ({ level: r.name, text: r.args.join(' ') }));
const go = (h, at) => h.advance(at - h.run('Date.now()'));
function register(h) { h.complete(); const ue = h.streamer(); h.advance(250); return ue; }
function finishStop(h, ue) {
    h.complete(); ue.finishClose(); h.advance(5250);
    assert.match(h.commands.at(-1).command, /Start_|restart$/);
    return register(h);
}

test('multi schedule: midnight/noon each execute once, then next midnight across dates', () => {
    const h = create();
    go(h, local(9)); let ue = register(h);
    assert.equal(status(h).last.result, 'ok'); assert.equal(starts(h).length, 1);
    go(h, local(9, 12)); ue = finishStop(h, ue);
    assert.equal(status(h).last.result, 'ok'); assert.equal(starts(h).length, 2);
    assert.equal(Date.parse(status(h).nextAt), local(10));
    go(h, local(10)); finishStop(h, ue);
    assert.equal(starts(h).length, 3); h.advance(60000); assert.equal(starts(h).length, 3);
});

test('multi schedule: unsorted inputs run chronologically without mutating configuration', () => {
    const h = create({ AppRestartTime: ['12:00', '00:00'] });
    assert.equal(Date.parse(status(h).nextAt), local(9));
    go(h, local(9)); const ue = register(h);
    assert.equal(Date.parse(status(h).nextAt), local(9, 12));
    go(h, local(9, 12)); finishStop(h, ue); assert.equal(starts(h).length, 2);
    assert.equal(h.run('config.AppRestartTime.join(",")'), '12:00,00:00');
});

test('multi schedule: shared weekday filter excludes both slots, includes both next day', () => {
    const h = create({ AppRestartDays: ['Tue'] });
    go(h, local(9, 23, 59)); assert.equal(h.commands.length, 0);
    go(h, local(10)); const ue = register(h);
    go(h, local(10, 12)); finishStop(h, ue);
    assert.equal(starts(h).length, 2); assert.equal(Date.parse(status(h).nextAt), local(17));
});

test('multi schedule: accepts empty, one and 24 times; empty array disables timers and heartbeat', () => {
    const hourly = Array.from({ length: 24 }, (_, n) => String(n).padStart(2, '0') + ':00');
    for (const times of [[], ['12:00'], hourly]) {
        const h = create({ AppRestartTime: times });
        assert.deepEqual(status(h).times, times); assert.equal(status(h).enabled, times.length > 0);
    }
    const h = create({ AppRestartTime: [] });
    assert.equal(h.run('scheduledRestartTimer'), null); assert.equal(status(h).time, '');
    assert.equal(status(h).nextAt, null); h.advance(86400000);
    assert.equal(h.commands.length, 0); assert.ok(!logs(h).some(r => r.text.includes('Next 3D restart:')));
    assert.equal(logs(h).filter(r => r.text.includes('[SCHEDULED_RESTART] disabled')).length, 1);
});

test('multi schedule: invalid arrays/scalars reject with INVALID_CONFIG and no supplied value', () => {
    const bad = ['24:00', '4:00', {}, null, 12, true, ['', '12:00'], ['12:00', 12], ['12:00', '12:00'],
        ['04:60'], ['private-time'], ['12:00', null], [{ toString: null, valueOf: null }, '12:00'],
        Array.from({ length: 25 }, (_, n) => `00:${String(n).padStart(2, '0')}`)];
    for (const time of bad) assert.throws(() => create({ AppRestartTime: time }), e =>
        e.code === 'INVALID_CONFIG' && e.message.includes('value omitted') && !e.message.includes('private-time'));
});

test('multi schedule: real yargs comma CLI and unchanged single string CLI', () => {
    for (const [arg, times] of [['00:00,12:00', ['00:00','12:00']], ['04:00', ['04:00']]]) {
        const argv = require('yargs/yargs')([`--AppRestartTime=${arg}`, '--AppRestartDays=Mon,Wed']).argv;
        const h = create({}, local(9, 0, -1), { argv });
        assert.deepEqual(status(h).times, times); assert.deepEqual(status(h).days, ['Mon','Wed']);
        assert.equal(status(h).time, arg);
    }
    for (const arg of ['00:00,', ',12:00', '00:00,00:00']) {
        assert.throws(() => create({}, local(9), { argv: { AppRestartTime: arg } }), { code: 'INVALID_CONFIG' });
    }
});

test('multi schedule: startup after first time skips it and runs remaining same-day slot', () => {
    const h = create({}, local(9, 0, 1));
    assert.equal(Date.parse(status(h).nextAt), local(9, 12));
    go(h, local(9, 12)); register(h); assert.equal(starts(h).length, 1);
});

test('multi schedule: sleep across two slots skips all with one warning; rollback cannot catch up', () => {
    const h = create(); h.jump(local(9, 13) - h.run('Date.now()')); h.advance(0);
    assert.equal(h.commands.length, 0); assert.equal(status(h).last.result, 'skipped:late-wakeup');
    assert.equal(logs(h).filter(r => r.level === 'warn' && r.text.includes('skipped:late-wakeup')).length, 1);
    assert.equal(Date.parse(status(h).nextAt), local(10));
    h.jump(local(9, 11, 59) - h.run('Date.now()')); h.run('armScheduledRestart()');
    go(h, local(9, 12)); assert.equal(h.commands.length, 0);
    go(h, local(10)); register(h); assert.equal(starts(h).length, 1);
});

test('multi schedule: two close slots crossed while sleeping both skip even inside lateness grace', () => {
    const h = create({ AppRestartTime: ['00:00','00:01'] });
    h.jump(121000); h.advance(0);
    assert.equal(h.commands.length, 0); assert.equal(status(h).last.result, 'skipped:late-wakeup');
    assert.equal(logs(h).filter(r => r.text.includes('skipped:late-wakeup')).length, 1);
});

test('multi schedule: late first slot alone skips while later same-day slot still runs', () => {
    const h = create(); h.jump(180001); h.advance(0);
    assert.equal(status(h).last.result, 'skipped:late-wakeup');
    assert.equal(Date.parse(status(h).nextAt), local(9, 12));
    go(h, local(9, 12)); register(h); assert.equal(starts(h).length, 1);
});

test('multi schedule: active registration skips next slot without overwriting operation or double START', () => {
    const h = create({ AppRestartTime: ['00:00','00:01'] }); go(h, local(9)); h.complete();
    go(h, local(9, 0, 1)); assert.equal(status(h).last.result, 'skipped:restart-active');
    assert.equal(starts(h).length, 1); assert.equal(h.run('scheduledRestartActive.dueAt'), local(9));
    h.streamer(); h.advance(250); assert.equal(status(h).last.result, 'ok');
    assert.equal(h.run('scheduledRestartStepTimer'), null);
    assert.equal(h.run('scheduledRestartActive'), null); assert.equal(starts(h).length, 1);
});

test('multi schedule: consumed occurrence survives backward clock and remaining same-day slot executes', () => {
    const h = create(); go(h, local(9)); const ue = register(h);
    h.jump(local(8, 23, 59) - h.run('Date.now()')); h.run('armScheduledRestart()');
    go(h, local(9)); assert.equal(starts(h).length, 1);
    go(h, local(9, 12)); finishStop(h, ue); assert.equal(starts(h).length, 2);
    const far = nextRestartAt(local(1), ['12:00','00:00'], ['Mon'], '2026-11-09T00:00');
    assert.equal(far, local(9, 12));
});

test('multi schedule: health time/times and local startup log list all times and next occurrence', () => {
    const h = create(); assert.deepEqual(status(h).times, ['00:00','12:00']);
    assert.equal(status(h).time, '00:00,12:00');
    assert.ok(logs(h).some(r => r.text.includes('enabled | time=00:00,12:00 |') && r.text.includes('next=2026-11-09 00:00 (Mon)')));
    h.advance(30000); assert.ok(logs(h).some(r => r.text.includes('Next 3D restart: 2026-11-09 00:00 (Mon)')));
    assert.equal(create({ AppRestartTime: '04:00' }).run('getServiceStatus().scheduledRestart.time'), '04:00');
});

test('multi schedule: real processes apply JSON array through loadConfig and expose compatible health', async () => {
    for (const times of [['00:00','12:00'], []]) {
        const s = await ops.start({ AppAutoStart: false, AppIdleTimeoutMs: 0, AppRestartTime: times });
        try {
            const health = await ops.get(s, '/healthz');
            assert.equal(health.status, 200); const schedule = health.body.scheduledRestart;
            assert.deepEqual(schedule.times, times); assert.equal(schedule.time, times.join(','));
            assert.equal(schedule.enabled, times.length > 0); assert.equal(schedule.nextAt === null, !times.length);
            await ops.until(() => s.logs.includes('[SCHEDULED_RESTART]'));
            assert.ok(s.logs.includes(`time=${times.join(',') || '-'}`));
        } finally { await s.close(); }
    }
});

test('multi schedule: DST fold preserves executed and every skipped slot across clock rollback', () => {
    const { spawnSync } = require('node:child_process');
    const script = `
        const assert = require('node:assert/strict');
        const { createHarness } = require('./tests/helpers/cirrus-v3-harness');
        function check(times, initial, wake, expected, consumed) {
            const h = createHarness({ AppAutoStart: false, AppIdleTimeoutMs: 0, AppRestartTime: times },
                { now: Date.parse(initial), autoOffer: true });
            h.jump(Date.parse(wake) - h.run('Date.now()')); h.advance(0);
            assert.equal(h.commands.length, expected);
            if (expected) { h.complete(); h.streamer(); h.advance(250); }
            else assert.equal(h.run('scheduledRestartLast.result'), 'skipped:late-wakeup');
            assert.equal(h.run('scheduledRestartConsumedThrough'), consumed);
            h.jump(Date.parse('2026-11-01T03:00:00Z') - h.run('Date.now()'));
            h.run('armScheduledRestart()'); h.advance(3 * 3600000);
            assert.equal(h.commands.length, expected, 'consumed slot repeated after rollback');
            assert.equal(h.run('scheduledRestartActive'), null);
            assert.equal(h.run('scheduledRestartNextAt'), Date.parse('2026-11-01T17:00:00Z'));
            h.advance(Date.parse('2026-11-01T17:00:00Z') - h.run('Date.now()'));
            assert.equal(h.commands.length, expected + 1, 'remaining noon slot did not run');
        }
        check(['01:59','12:00'], '2026-11-01T05:58:59Z', '2026-11-01T06:00:01Z', 1, '2026-11-01T01:59');
        check(['01:10','01:59','12:00'], '2026-11-01T05:09:00Z', '2026-11-01T06:00:01Z', 0, '2026-11-01T01:59');
    `;
    const child = spawnSync(process.execPath, ['-e', script], { cwd: require('node:path').resolve(__dirname, '..'),
        env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.ifError(child.error); assert.equal(child.status, 0, child.stderr);
});
