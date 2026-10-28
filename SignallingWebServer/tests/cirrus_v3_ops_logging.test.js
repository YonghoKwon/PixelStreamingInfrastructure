const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createHarness } = require('./helpers/cirrus-v3-harness');
const { createLogRedactor, installErrorFileLogger } = require('../modules/cirrus-v3-support');

test('v3 error/warn file keeps the same timestamped stderr line and redacts secrets', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cirrus-ops-log-'));
    try {
        const stderr = []; const r = createLogRedactor(); r.remember({ credential: 'OPS_TEST_SECRET_71' });
        const target = { error: line => stderr.push(line), warn: line => stderr.push(line) };
        const stream = installErrorFileLogger(target, { directory, redact: r.redact,
            now: () => new Date(2026, 9, 28, 12, 34, 56, 789) });
        target.error('launcher error %s', 'OPS_TEST_SECRET_71');
        target.warn('warning %j', { password: 'hidden', normal: 'visible' });
        stream.end(); await once(stream, 'close');
        const contents = fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0]), 'utf8');
        assert.equal(contents, stderr.join('\n') + '\n'); assert.match(contents, /12:34:56\.789 launcher error \[REDACTED\]/);
        assert.ok(contents.includes('visible')); assert.ok(!contents.includes('hidden')); assert.ok(!contents.includes('OPS_TEST_SECRET_71'));
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('entry point enables the error file only with LogToFile', () => {
    const enabled = createHarness(); const disabled = createHarness({ LogToFile: false });
    enabled.run("console.error('OPS_LOG_ERROR')"); disabled.run("console.error('OPS_LOG_ERROR')");
    assert.match(enabled.logs.at(-1).args[0], /^\d\d:\d\d:\d\d\.\d{3} OPS_LOG_ERROR$/);
    assert.equal(disabled.logs.at(-1).args[0], 'OPS_LOG_ERROR');
});
