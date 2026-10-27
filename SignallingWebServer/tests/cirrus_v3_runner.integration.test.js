const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createCommandRunner } = require('../modules/cirrus-v3-support');

function groupAlive(pid) {
    try { process.kill(-pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function runOwned(script, live = false) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cirrus-v3-owned-'));
    const file = path.join(dir, 'launcher.sh'); fs.writeFileSync(file, '#!/bin/sh\n' + script); fs.chmodSync(file, 0o700);
    let child; const signals = [];
    const result = await new Promise(resolve => {
        const runner = createCommandRunner({ timeoutMs: 1000, graceMs: 150, platform: 'linux', hasLiveApp: () => live,
            spawn: (...args) => (child = spawn(...args)), kill: (pid, signal) => { if (signal) signals.push({ pid, signal }); return process.kill(pid, signal); } });
        runner.run(file, error => resolve({ error, state: runner.snapshot() }));
    });
    return { ...result, child, signals };
}
test('real Linux owned shell and descendants terminate on deadline', { skip: process.platform !== 'linux' }, async () => {
    const r = await runOwned('sleep 60 &\nwait\n');
    assert.equal(r.error.code, 'APP_COMMAND_TIMEOUT'); assert.equal(groupAlive(r.child.pid), false);
    assert.ok(r.signals.every(s => s.pid === -r.child.pid));
});
test('real Linux TERM-resistant owned group is escalated and confirmed gone', { skip: process.platform !== 'linux' }, async () => {
    const r = await runOwned("trap '' TERM\nwhile :; do sleep 1; done\n");
    assert.equal(r.error.code, 'APP_COMMAND_TIMEOUT'); assert.equal(groupAlive(r.child.pid), false);
    assert.ok(r.signals.some(s => s.signal === 'SIGKILL'));
});
test('real foreground process is preserved when UE registration is reported', { skip: process.platform !== 'linux' }, async () => {
    const r = await runOwned('sleep 60 &\nwait\n', true);
    try {
        assert.equal(r.state.blockedReason, 'TIMEOUT_WITH_LIVE_APP'); assert.equal(groupAlive(r.child.pid), true); assert.deepEqual(r.signals, []);
    } finally {
        // Test cleanup of this exact newly spawned stand-in, never a UE/global PID.
        if (groupAlive(r.child.pid)) process.kill(-r.child.pid, 'SIGKILL');
        await new Promise(resolve => r.child.once('close', resolve));
    }
});
