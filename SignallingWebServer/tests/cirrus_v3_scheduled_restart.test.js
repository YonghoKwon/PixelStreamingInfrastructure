'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness } = require('./helpers/cirrus-v3-harness');
const { nextRestartAt } = require('../modules/cirrus-v3-support');
const ops = require('./helpers/cirrus-ops-server');
const monday = new Date(2026, 10, 9, 3, 59).getTime();
const day = 86400000;
const harness = (config = {}, options = {}) => createHarness({ AppAutoStart: false, AppIdleTimeoutMs: 0,
    AppRestartTime: '04:00', ...config }, { now: monday, autoOffer: true, closedSendCallback: true, ...options });
const result = h => h.run('scheduledRestartLast.result');
const starts = h => h.commands.filter(c => /Start_|restart$/.test(c.command));
const due = h => h.advance(60000);
function stopAndStart(h, ue) {
    due(h); h.complete(); ue.finishClose(); h.advance(250);
    h.advance(4999); assert.equal(starts(h).length, 0);
    h.advance(1); assert.equal(starts(h).length, 1);
}

test('schedule: omitted settings create no scheduler timer and preserve readiness', () => {
    const h = createHarness({}, { autoOffer: true });
    assert.equal(h.run('scheduledRestartTimer'), null);
    assert.equal(h.run('getServiceStatus().scheduledRestart.enabled'), false);
    assert.equal(h.run('getServiceStatus().scheduledRestart.nextAt'), null);
    assert.equal(h.run('getServiceStatus().ready'), false);
    h.streamer(); assert.equal(h.run('getServiceStatus().ready'), true);
    assert.equal(h.logs.filter(r => r.args.join(' ').includes('[SCHEDULED_RESTART] disabled')).length, 1);
    h.advance(60000); assert.equal(h.commands.length, 0);
    assert.ok(!h.logs.some(r => r.args.join(' ').includes('Next 3D restart:')));
});

test('schedule: strict config accepts boundaries, a weekday, all weekdays and real yargs CLI', () => {
    for (const time of ['', '00:00', '23:59']) for (const days of [['Mon'], ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']]) {
        assert.equal(harness({ AppRestartTime: time, AppRestartDays: days }).run('config.AppRestartTime'), time);
    }
    const argv = require('yargs/yargs')(['--AppRestartTime=23:59', '--AppRestartDays=Mon,Wed']).argv;
    const h = harness({}, { argv });
    assert.equal(h.run('config.AppRestartDays.join(",")'), 'Mon,Wed');
    assert.equal(h.run('config.AppRestartTime'), '23:59');
});

test('schedule: invalid config refuses startup without printing supplied values', () => {
    for (const time of ['4:00', '24:00', '04:60', 400, null, false, '04:00\n', 'private-time']) {
        assert.throws(() => harness({ AppRestartTime: time }), e => e.code === 'INVALID_CONFIG' && e.message.includes('value omitted') && !e.message.includes('private-time'));
    }
    for (const days of [[], ['mon'], ['Mon','Mon'], ['Unknown'], 'Mon', 1, null, {}]) {
        assert.throws(() => harness({ AppRestartDays: days }), e => e.code === 'INVALID_CONFIG' && e.message.includes('value omitted'));
    }
    assert.throws(() => harness({}, { argv: { AppRestartDays: 'Mon,,Wed' } }), { code: 'INVALID_CONFIG' });
});

test('schedule: days alone warn once and stay disabled', () => {
    const h = harness({ AppRestartTime: '', AppRestartDays: ['Mon'] });
    h.advance(day);
    assert.equal(h.commands.length, 0);
    assert.equal(h.logs.filter(r => r.name === 'warn' && r.args.join(' ').includes('supplied without')).length, 1);
});

test('schedule: weekday filter, strict future startup, and calendar calculation', () => {
    const h = harness({ AppRestartDays: ['Tue'] });
    due(h); assert.equal(h.commands.length, 0);
    h.advance(day); assert.equal(starts(h).length, 1);
    assert.equal(new Date(nextRestartAt(monday, '04:00', ['Tue'])).getDay(), 2);
    const late = harness({}, { now: monday + 61000 });
    late.advance(day - 1001); assert.equal(late.commands.length, 0);
    late.advance(1); assert.equal(starts(late).length, 1);
});

test('schedule: two active browsers close 1012, STOP drains, grace, forced START, F7a reattach', () => {
    const h = harness(); const ue = h.streamer(); const viewers = [h.player(), h.player()];
    for (const p of viewers) p.message({ type: 'subscribe', streamerId: 'A' });
    h.advance(0); assert.ok(viewers.every(p => p.sent.some(m => m.type === 'offer')));
    due(h);
    for (const p of viewers) {
        assert.deepEqual(p.closeCalls[0], { code: 1012, reason: 'scheduled 3D restart' }); p.finishClose(1012);
    }
    assert.match(h.commands[0].command, /Stop_/); assert.equal(ue.closeCalls.length, 1);
    const waiting = [h.player(), h.player()];
    for (const p of waiting) p.message({ type: 'subscribe', streamerId: 'A' });
    assert.ok(waiting.every(p => !h.run(`players.get('${h.playerId(p)}').streamerId`)));
    ue.finishClose(); h.complete(); h.advance(250); h.advance(5000);
    assert.equal(starts(h).length, 1); h.complete(); h.streamer(); h.advance(1250);
    assert.equal(result(h), 'ok');
    assert.ok(waiting.every(p => p.sent.some(m => m.type === 'offer')));
    assert.ok(waiting.every(p => p.closeCalls.length === 0));
    h.advance(60000); assert.equal(starts(h).length, 1);
    assert.equal(h.run('getServiceStatus().scheduledRestart.last.result'), 'ok');
    assert.ok(h.logs.some(r => r.args.join(' ').includes('Next 3D restart:')));
});

test('schedule: always-on absent UE starts once without STOP or browser demand', () => {
    const h = harness(); due(h);
    assert.equal(h.commands.length, 1); assert.equal(starts(h).length, 1);
    h.complete(); h.streamer(); h.advance(250); assert.equal(result(h), 'ok');
});

test('schedule: missing UE skips on-demand and mixed idle modes', () => {
    for (const config of [{ AppAutoStart: true }, { AppIdleTimeoutMs: 60000 }]) {
        const h = harness(config); due(h);
        assert.equal(h.commands.length, 0); assert.equal(result(h), 'skipped:ue-off');
    }
});

test('schedule: busy command waits at 30-second intervals then runs', () => {
    const h = harness({ AppAutoStart: true }); h.player(); due(h);
    assert.equal(h.commands.length, 1); h.complete(); const ue = h.streamer();
    h.advance(29999); assert.equal(h.commands.length, 1);
    h.advance(1); assert.match(h.commands[1].command, /Stop_/);
    h.complete(); ue.finishClose(); h.advance(5250); assert.equal(starts(h).length, 2);
});

test('schedule: busy deadline skips without resetting existing launcher state', () => {
    const h = harness({ AppAutoStart: true }); h.player(); due(h); h.advance(600000);
    assert.equal(h.commands.length, 1); assert.equal(result(h), 'skipped:command-busy');
    assert.notEqual(h.run('appStartTime'), null);
});

test('schedule: blocked runner skips without disconnecting viewers', () => {
    const h = harness({ AppCommandTimeoutMs: 1000 }); const ue = h.streamer(); const p = h.player();
    h.run('runAppCommand(STOP_CMD, () => {})'); h.advance(1000);
    assert.equal(h.run('appCommandRunner.isBlocked()'), true);
    h.advance(59000); assert.equal(result(h), 'skipped:launcher-blocked');
    assert.equal(ue.closeCalls.length, 0); assert.equal(p.closeCalls.length, 0);
});

test('schedule: missing registration retries bounded budget, no continued START, next day fresh budget', () => {
    const h = harness({ AppStartMaxAttempts: 2, AppStartCooldownMs: 60000 }); due(h); h.complete();
    h.advance(90000); assert.equal(starts(h).length, 2); h.complete();
    h.advance(90000); assert.equal(result(h), 'failed:registration-timeout');
    assert.equal(h.run('scheduledRestartStepTimer'), null);
    h.player(); h.advance(3600000); assert.equal(starts(h).length, 2);
    const next = h.run('scheduledRestartNextAt'); h.advance(next - h.run('Date.now()'));
    assert.equal(starts(h).length, 3); assert.equal(h.run('scheduledRestartActive.attempts'), 1);
});

test('schedule: browser, idle, queued lifecycle, zombie and slow retry cannot double START', () => {
    const h = harness({ AppAutoStart: true, AppIdleTimeoutMs: 60000, AppStartCooldownMs: 60000 });
    const ue = h.streamer(); stopAndStart(h, ue);
    const waiting = h.player(); h.run('startApp(true); stopApp(true); scheduleSlowStartRetry(); startIdleTimer();');
    h.run('startAfterStop = true; stopAfterStart = true');
    h.advance(60000); assert.equal(starts(h).length, 1);
    h.complete(); h.streamer(); h.advance(1250);
    assert.ok(waiting.sent.some(m => m.type === 'offer'));
    assert.equal(starts(h).length, 1); assert.equal(result(h), 'ok');
});

test('schedule: STOP socket drain deadline warns then starts after five seconds', () => {
    const h = harness(); h.streamer(); due(h); h.complete();
    h.advance(60000); assert.equal(starts(h).length, 0);
    h.advance(5000); assert.equal(starts(h).length, 1);
    assert.ok(h.logs.some(r => r.name === 'warn' && r.args.join(' ').includes('drain exceeded')));
});

test('schedule: long STOP launcher remains serialized after drain/grace deadline', () => {
    const h = harness(); const ue = h.streamer(); due(h); ue.finishClose();
    h.advance(65000); assert.equal(h.commands.length, 1);
    h.complete(); h.advance(250); assert.equal(starts(h).length, 1);
});

test('schedule: START error still observes registration deadline and blocked attempt fails closed', () => {
    const h = harness({ AppStartMaxAttempts: 1 }); due(h); h.complete(0, new Error('synthetic'));
    h.advance(90000); assert.equal(result(h), 'failed:registration-timeout');
    const blocked = harness({ AppCommandTimeoutMs: 1000 }); due(blocked); blocked.streamer(); blocked.advance(1250);
    assert.equal(result(blocked), 'failed:launcher-blocked'); assert.equal(starts(blocked).length, 1);
});

test('schedule: wake later than two minutes skips, two-minute boundary executes', () => {
    const h = harness(); h.jump(180001); h.advance(0);
    assert.equal(result(h), 'skipped:late-wakeup'); assert.equal(h.commands.length, 0);
    const boundary = harness(); boundary.jump(180000); boundary.advance(0);
    assert.equal(starts(boundary).length, 1);
});

test('schedule: clock rollback cannot repeat consumed local date, timers cap at one hour', () => {
    const h = harness(); due(h); h.complete(); h.streamer(); h.advance(250);
    h.jump(-60000); h.run('armScheduledRestart()'); h.advance(60000);
    assert.equal(starts(h).length, 1);
    assert.ok(h.run('scheduledRestartTimer.delay <= 3600000'));
    const far = nextRestartAt(monday - 40 * day, '04:00', ['Mon'], '2026-11-09');
    assert.equal(new Date(far).getDate(), 16);
});

test('schedule: real processes load both example configs, enabled and disabled health and readiness', async () => {
    for (const name of ['always-on', 'on-demand']) for (const enabled of [false, true]) {
        const example = JSON.parse(fs.readFileSync(path.join(__dirname, `../config.${name}.example.json`), 'utf8'));
        const s = await ops.start({ ...example, AppRestartTime: enabled ? '23:59' : '', AppRestartDays: ['Mon','Wed'] });
        try {
            const health = await ops.get(s, '/healthz'); const ready = await ops.get(s, '/readyz');
            assert.equal(health.status, 200); assert.equal(ready.status, 503);
            assert.equal(health.body.scheduledRestart.enabled, enabled);
            assert.deepEqual(health.body.scheduledRestart.days, ['Mon','Wed']);
            assert.equal(health.body.scheduledRestart.nextAt === null, !enabled);
            assert.deepEqual(health.body.scheduledRestart.last, { at: null, result: null });
        } finally { await s.close(); }
    }
});
