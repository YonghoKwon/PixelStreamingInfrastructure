const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createLogRedactor, loadConfig, certificatePath, createCommandRunner } = require('../modules/cirrus-v3-support');

function fakeRunner(settings = {}) {
    let now = 0, nextPid = 5000;
    const timers = new Set(), commands = [], signals = [], outcomes = [];
    const later = (fn, ms) => { const timer = { fn, at: now + ms }; timers.add(timer); return timer; };
    const advance = ms => {
        const end = now + ms;
        for (;;) {
            const timer = [...timers].filter(t => t.at <= end).sort((a, b) => a.at - b.at)[0];
            if (!timer) break;
            now = timer.at; timers.delete(timer); timer.fn();
        }
        now = end;
    };
    const launch = (command, args, options) => {
        const child = new EventEmitter();
        Object.assign(child, { pid: ++nextPid, stdout: new EventEmitter(), stderr: new EventEmitter(), alive: true });
        child.kill = signal => { signals.push({ pid: child.pid, signal }); child.alive = false; child.emit('exit', null, signal); };
        commands.push({ command, args, options, child }); return child;
    };
    const kill = (pid, signal) => {
        const child = commands.find(c => c.child.pid === -pid)?.child;
        if (!child?.alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
        if (signal === 0) return;
        signals.push({ pid, signal });
        if (signal === 'SIGKILL' || settings.termExits !== false) { child.alive = false; child.emit('exit', null, signal); }
    };
    const runner = createCommandRunner({ spawn: launch, kill, platform: settings.platform || 'linux', now: () => now,
        setTimeout: later, clearTimeout: t => timers.delete(t), timeoutMs: 1000, graceMs: 100,
        maxTimeouts: settings.maxTimeouts || 3, hasLiveApp: () => !!settings.live });
    return { runner, commands, signals, outcomes, advance, run: command => runner.run(command, error => outcomes.push(error?.code || 'OK')) };
}

test('redacts nested and stringified ICE credentials without changing wire configuration', () => {
    const config = { peerConnectionOptions: JSON.stringify({ iceServers: [{ urls: ['turn:localhost'], credential: 'qa-pass-123' }] }), password: 'second-pass' };
    const original = JSON.stringify(config); const r = createLogRedactor(); r.remember(config);
    const output = JSON.stringify(r.redact(config));
    assert.ok(!output.includes('qa-pass-123')); assert.ok(!output.includes('second-pass'));
    assert.equal(JSON.stringify(config), original);
});
test('logger wrapper covers console/file dispatch and preserves format arguments', () => {
    const rows = []; const target = Object.fromEntries(['log', 'warn', 'error', 'logColor'].map(k => [k, (...args) => rows.push(args)]));
    const r = createLogRedactor(); r.remember({ credential: 'qa-credential-789' }); r.install(target);
    target.log('Config: %s', '{"credential":"qa-credential-789"}'); target.logColor('green', 'message %s', { api_key: 'api-value' }); target.error(new Error('qa-credential-789'));
    assert.equal(rows[0][0], 'Config: %s'); assert.ok(!JSON.stringify(rows).includes('qa-credential-789')); assert.ok(!JSON.stringify(rows).includes('api-value'));
});
test('escaped secrets and URL userinfo do not survive serialization', () => {
    const r = createLogRedactor(); const secret = 'quote"slash\\newline\n'; r.remember({ credential: secret });
    const output = r.redact('Config: ' + JSON.stringify({ ice: JSON.stringify({ credential: secret }) }));
    assert.ok(!output.includes(JSON.stringify(secret).slice(1, -1))); assert.match(r.redact('https://name:pass@example.test/a'), /REDACTED/);
});
test('circular log objects do not crash logging', () => { const r = createLogRedactor(); const a = { token: 'value' }; a.self = a; assert.doesNotThrow(() => r.redact(a)); });
test('session ICE passwords and URL tokens are hidden without changing the message', () => {
    const r = createLogRedactor(); const message = { sdp: 'v=0\r\na=ice-pwd:SESSION_SECRET\r\na=ice-ufrag:SESSION_UFRAG\r\n', url: 'https://example.test/?token=URL_SECRET&mode=1' };
    const text = JSON.stringify(r.redact(message)); assert.ok(!text.includes('SESSION_SECRET')); assert.ok(!text.includes('URL_SECRET')); assert.ok(message.sdp.includes('SESSION_SECRET'));
});
test('Buffer log payloads receive recursive JSON redaction', () => {
    const r = createLogRedactor();
    const value = Buffer.from(JSON.stringify({ nested: JSON.stringify({ accessToken: 'BUFFER_SECRET' }) }));
    assert.ok(!r.redact(value).includes('BUFFER_SECRET'));
});
test('absolute and relative certificate paths are resolved using the declared base', () => {
    const base = path.resolve('fixture'); const absolute = path.resolve('outside/key.pem');
    assert.equal(certificatePath(base, absolute), absolute); assert.equal(certificatePath(base, 'cert/key.pem'), path.resolve(base, 'cert/key.pem'));
    assert.throws(() => certificatePath(base, ''), /nonempty/);
});
const defaults = { HttpMode: 'certificate-only', AppCommandTimeoutMs: 60000, AppCommandKillGraceMs: 5000, AppCommandMaxTimeouts: 3 };
test('config priority is defaults < file < CLI and configuration files are not written', () => {
    const config = loadConfig('x', { ...defaults, HttpPort: 80 }, { HttpPort: 8081, _: ['ignored'], $0: 'ignored' }, { readFileSync: () => '{"HttpPort":8080}' });
    assert.equal(config.HttpPort, 8081); assert.equal(config._, undefined);
});
test('invalid config values and malformed JSON omit contents from errors', () => {
    assert.throws(() => loadConfig('x', defaults, {}, { readFileSync: () => '{"credential":"QA_SECRET_INVALID"' }), e => e.code === 'INVALID_CONFIG' && !e.message.includes('QA_SECRET_INVALID'));
    assert.throws(() => loadConfig('x', defaults, { AppCommandTimeoutMs: 0 }, { readFileSync: () => '{}' }), /AppCommandTimeoutMs/);
    assert.throws(() => loadConfig('x', defaults, { HttpMode: 'unsafe' }, { readFileSync: () => '{}' }), /HttpMode/);
});
test('normal command completion releases the gate exactly once', () => {
    const h = fakeRunner(); assert.ok(h.run('start')); assert.equal(h.run('duplicate'), false); h.commands[0].child.emit('exit', 0, null); h.commands[0].child.emit('error', new Error('late'));
    h.advance(10000); assert.deepEqual(h.outcomes, ['OK']); assert.equal(h.runner.snapshot().state, 'idle'); assert.deepEqual(h.signals, []);
});
test('Linux hung launcher group is terminated before another command can run', () => {
    const h = fakeRunner(); h.run('start'); h.advance(999); assert.deepEqual(h.signals, []); h.advance(1);
    assert.deepEqual(h.outcomes, ['APP_COMMAND_TIMEOUT']); assert.equal(h.signals[0].pid, -5001); assert.equal(h.signals[0].signal, 'SIGTERM'); assert.ok(h.run('next'));
});
test('resistant owned group escalates after grace and never overlaps cleanup', () => {
    const h = fakeRunner({ termExits: false }); h.run('start'); h.advance(1000); assert.equal(h.run('too early'), false); h.advance(150);
    assert.deepEqual(h.signals.map(s => s.signal), ['SIGTERM', 'SIGKILL']); assert.equal(h.outcomes.length, 1); assert.ok(h.run('after cleanup'));
});
test('registered UE is preserved and the service explicitly blocks further launches', () => {
    const h = fakeRunner({ live: true }); h.run('foreground launcher'); h.advance(1000);
    assert.deepEqual(h.signals, []); assert.equal(h.runner.snapshot().blockedReason, 'TIMEOUT_WITH_LIVE_APP'); assert.equal(h.run('unsafe retry'), false); h.runner.noteRegistered(); assert.ok(h.runner.isBlocked());
});
test('repeated command timeouts reach a bounded failure state', () => {
    const h = fakeRunner({ maxTimeouts: 2 }); h.run('first'); h.advance(1000); h.run('second'); h.advance(1000);
    assert.equal(h.runner.snapshot().blockedReason, 'TIMEOUT_LIMIT'); assert.equal(h.commands.length, 2); assert.equal(h.run('third'), false);
});
test('real registration resets consecutive timeout count before the limit', () => {
    const h = fakeRunner(); h.run('first'); h.advance(1000); h.runner.noteRegistered(); assert.equal(h.runner.snapshot().consecutiveTimeouts, 0);
});
test('Windows timeout does not assume cmd child-tree cleanup succeeded', () => {
    const h = fakeRunner({ platform: 'win32' }); h.run('cmd start'); h.advance(1000);
    assert.equal(h.runner.snapshot().blockedReason, 'WINDOWS_TIMEOUT_REQUIRES_OWNED_TREE_CLEANUP'); assert.equal(h.signals[0].pid, 5001); assert.equal(h.run('duplicate'), false);
});
test('launcher output is bounded while output streams remain drained', () => {
    const h = fakeRunner(); let size = 0; h.runner.run('start', (_, stdout) => size = stdout.length);
    h.commands[0].child.stdout.emit('data', Buffer.alloc(100000, 'a')); h.commands[0].child.emit('exit', 0, null); assert.equal(size, 65536);
});
