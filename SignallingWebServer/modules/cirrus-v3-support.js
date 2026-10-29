'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { format } = require('node:util');
const { spawn } = require('node:child_process');

const secretKey = /password|passphrase|credential|secret|token|authorization|api[-_]?key|private[-_]?key/i;

function createLogRedactor() {
    const secrets = new Set();
    function remember(value) {
        if (!value || typeof value !== 'object') return;
        for (const [key, item] of Object.entries(value)) {
            if (secretKey.test(key) && typeof item === 'string' && item.length >= 4) {
                let encoded = item;
                for (let i = 0; i < 3; i++) { secrets.add(encoded); encoded = JSON.stringify(encoded).slice(1, -1); }
            }
            if (typeof item === 'string') {
                try { remember(JSON.parse(item)); } catch { /* May be an ordinary string. */ }
            } else remember(item);
        }
    }
    function text(value) {
        let out = value;
        for (const secret of secrets) out = out.split(secret).join('[REDACTED]');
        out = out.replace(/((?:["']?)(?:password|passphrase|credential|secret|token|authorization|api[-_]?key|private[-_]?key)(?:["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, '$1"[REDACTED]"');
        out = out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@');
        out = out.replace(/(\b(?:turns?|stuns?):)[^\s/@]+@/gi, '$1[REDACTED]@');
        out = out.replace(/(\ba=ice-(?:pwd|ufrag):)[^\s\\]+/gi, '$1[REDACTED]');
        out = out.replace(/([?&](?:access_token|token|api_key|client_secret|password|credential)=)[^&#\s]+/gi, '$1[REDACTED]');
        return out;
    }
    function redact(value, seen = new WeakSet()) {
        if (typeof value === 'string') {
            if (/^\s*[\[{]/.test(value)) {
                try { return JSON.stringify(redact(JSON.parse(value), seen)); } catch { /* Not complete JSON. */ }
            }
            return text(value);
        }
        if (!value || typeof value !== 'object') return value;
        if (value instanceof Error) return { name: value.name, code: value.code, message: text(value.message) };
        if (Buffer.isBuffer(value)) return redact(value.toString('utf8'), seen);
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
        if (Array.isArray(value)) return value.map(item => redact(item, seen));
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secretKey.test(key) ? '[REDACTED]' : redact(item, seen)]));
    }
    function install(target) {
        for (const method of ['log', 'warn', 'error', 'logColor']) {
            if (typeof target[method] !== 'function') continue;
            const original = target[method].bind(target);
            target[method] = (...args) => original(...args.map(arg => redact(arg)));
        }
    }
    return { remember, redact, install };
}

function loadConfig(file, defaults, argv, fileSystem = fs) {
    let loaded = {};
    try {
        loaded = JSON.parse(fileSystem.readFileSync(file, 'utf8'));
        if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) throw new Error('invalid root');
    } catch (error) {
        if (error.code !== 'ENOENT') {
            const failure = new Error('Cannot read configuration: expected a readable JSON object (contents omitted).');
            failure.code = 'INVALID_CONFIG';
            throw failure;
        }
    }
    const cli = { ...argv };
    for (const key of ['_', '$0', 'help', 'version']) delete cli[key];
    const config = { MaxWebSocketPayloadBytes: 4 * 1024 * 1024, AppStartMaxAttempts: 3, PlayerKeepaliveTimeoutMs: 30000, AppStartCooldownMs: 600000, ...defaults, ...loaded, ...cli };
    for (const [key, min, max] of [['AppCommandTimeoutMs', 1000, 1800000], ['AppCommandKillGraceMs', 100, 60000], ['AppCommandMaxTimeouts', 1, 10], ['MaxWebSocketPayloadBytes', 65536, 104857600], ['AppStartMaxAttempts', 1, 10]]) {
        if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) {
            const error = new Error(`Invalid ${key}: expected integer ${min}..${max} (value omitted).`);
            error.code = 'INVALID_CONFIG';
            throw error;
        }
    }
    if (!Number.isInteger(config.PlayerKeepaliveTimeoutMs) ||
        (config.PlayerKeepaliveTimeoutMs !== 0 && (config.PlayerKeepaliveTimeoutMs < 5000 || config.PlayerKeepaliveTimeoutMs > 600000))) {
        const error = new Error('Invalid PlayerKeepaliveTimeoutMs: expected 0 or integer 5000..600000 (value omitted).');
        error.code = 'INVALID_CONFIG'; throw error;
    }
    if (!Number.isInteger(config.AppStartCooldownMs) ||
        (config.AppStartCooldownMs !== 0 && (config.AppStartCooldownMs < 60000 || config.AppStartCooldownMs > 3600000))) {
        const error = new Error('Invalid AppStartCooldownMs: expected 0 or integer 60000..3600000 (value omitted).');
        error.code = 'INVALID_CONFIG'; throw error;
    }
    if (!['certificate-only', 'web'].includes(config.HttpMode)) {
        const error = new Error('Invalid HttpMode: use certificate-only or web (value omitted).');
        error.code = 'INVALID_CONFIG';
        throw error;
    }
    return config;
}

function certificatePath(baseDirectory, configuredPath) {
    if (typeof configuredPath !== 'string' || !configuredPath.trim()) throw new Error('Certificate path must be a nonempty string.');
    return path.isAbsolute(configuredPath) ? path.normalize(configuredPath) : path.resolve(baseDirectory, configuredPath);
}

// RFC 6455 reserves two bytes of the 125-byte control payload for the code.
function closeReason(value) {
    let text;
    try { text = value == null ? '' : String(value); }
    catch { text = 'Invalid disconnect reason'; }
    let result = '', bytes = 0;
    for (const character of text) {
        const size = Buffer.byteLength(character, 'utf8');
        if (bytes + size > 123) break;
        result += character;
        bytes += size;
    }
    return result;
}

// WebSocket control frames, not UE JSON keepalives. This owns one browser's
// timer only; termination flows through the existing close/admission cleanup.
function monitorPlayerSocket(ws, timeoutMs, options = {}) {
    if (timeoutMs === 0) return;
    const every = options.setInterval || setInterval;
    const cancel = options.clearInterval || clearInterval;
    let alive = true, expired = false;
    const pong = () => { alive = true; };
    const cleanup = () => { cancel(timer); ws.removeListener('pong', pong); ws.removeListener('close', cleanup); };
    const expire = () => {
        if (expired) return;
        expired = true; cleanup(); options.onTimeout?.(); ws.terminate();
    };
    ws.on('pong', pong);
    const timer = every(() => {
        if (ws.readyState !== 1) return cleanup();
        if (!alive) return expire();
        alive = false;
        try { ws.ping(); } catch { expire(); }
    }, timeoutMs);
    timer.unref?.();
    ws.once('close', cleanup);
    return cleanup;
}

// The shared logger keeps its stream private. Own a v3 error/warn file instead
// of modifying that module or duplicating these messages on stdout.
function installErrorFileLogger(target, options = {}) {
    const fileSystem = options.fileSystem || fs;
    const directory = options.directory || './logs/';
    const now = options.now || (() => new Date());
    const redact = options.redact || (value => value);
    const date = now();
    const pad = (value, width = 2) => String(value).padStart(width, '0');
    const name = `${date.getFullYear()}.${pad(date.getMonth())}.${pad(date.getDate())}.${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}.error.log`;
    fileSystem.mkdirSync(directory, { recursive: true });
    const output = fileSystem.createWriteStream(path.join(directory, name), { flags: 'a' });
    const originals = {};
    for (const method of ['error', 'warn']) {
        originals[method] = target[method].bind(target);
        target[method] = (...args) => {
            const time = now();
            const prefix = `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}.${pad(time.getMilliseconds(), 3)}`;
            const line = `${prefix} ${format(...args.map(value => redact(value)))}`;
            originals[method](line);
            output.write(line + '\n');
        };
    }
    output.on('error', () => originals.error('Cirrus v3 error log write failed (details omitted).'));
    return output;
}

// Owns only the processes it spawns. No global process-name or UE PID searches.
function createCommandRunner(options = {}) {
    const launch = options.spawn || spawn;
    const platform = options.platform || process.platform;
    const kill = options.kill || ((pid, signal) => process.kill(pid, signal));
    const later = options.setTimeout || setTimeout;
    const cancel = options.clearTimeout || clearTimeout;
    const now = options.now || Date.now;
    const hasLiveApp = options.hasLiveApp || (() => false);
    const timeoutMs = options.timeoutMs || 60000;
    const graceMs = options.graceMs || 5000;
    const maxTimeouts = options.maxTimeouts || 3;
    let active = null;
    let blocked = null;
    let timeouts = 0;
    let lastError = null;
    function snapshot() {
        return { state: blocked ? 'blocked' : active ? 'running' : 'idle', operation: active?.kind || null, consecutiveTimeouts: timeouts, lastErrorCode: lastError, blockedReason: blocked };
    }
    function run(command, callback, kind = 'start') {
        if (active || blocked) return false;
        const op = { kind, child: null, exited: false, finished: false, timedOut: false, timers: [], stdout: '', stderr: '' };
        active = op;
        function timer(fn, delay) { const handle = later(fn, delay); op.timers.push(handle); return handle; }
        function finish(error) {
            if (op.finished) return;
            op.finished = true;
            for (const handle of op.timers) cancel(handle);
            if (active === op) active = null;
            if (error) lastError = error.code || 'APP_COMMAND_FAILED';
            callback(error || null, op.stdout, op.stderr);
        }
        function groupAlive() {
            try { kill(-op.child.pid, 0); return true; }
            catch (error) { if (error.code === 'ESRCH') return false; throw error; }
        }
        function signalGroup(signal) {
            try { kill(-op.child.pid, signal); }
            catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
        const timeoutError = () => Object.assign(new Error('3D launcher command exceeded its completion deadline.'), { code: 'APP_COMMAND_TIMEOUT' });
        function timeout() {
            if (op.finished) return;
            op.timedOut = true;
            timeouts++;
            if (timeouts >= maxTimeouts) blocked = 'TIMEOUT_LIMIT';
            if (hasLiveApp()) {
                // A foreground/blocked launcher must not kill an already registered UE.
                blocked = 'TIMEOUT_WITH_LIVE_APP';
                return finish(timeoutError());
            }
            if (!Number.isInteger(op.child?.pid) || op.child.pid <= 1) {
                blocked = 'INVALID_OWNED_PID';
                return finish(timeoutError());
            }
            if (platform === 'win32') {
                // Killing cmd.exe cannot prove its descendants ended; fail closed.
                blocked = 'WINDOWS_TIMEOUT_REQUIRES_OWNED_TREE_CLEANUP';
                if (!op.exited) op.child.kill('SIGTERM');
                return finish(timeoutError());
            }
            const termDeadline = now() + graceMs;
            const finalDeadline = termDeadline + graceMs;
            let sentKill = false;
            function poll() {
                if (op.finished) return;
                try {
                    if (!groupAlive()) return finish(timeoutError());
                    if (!sentKill && now() >= termDeadline) { signalGroup('SIGKILL'); sentKill = true; }
                    if (now() >= finalDeadline) {
                        blocked = 'APP_COMMAND_CLEANUP_UNCONFIRMED';
                        return finish(timeoutError());
                    }
                    timer(poll, 50);
                } catch {
                    blocked = 'APP_COMMAND_CLEANUP_UNCONFIRMED';
                    finish(timeoutError());
                }
            }
            try { signalGroup('SIGTERM'); poll(); }
            catch { blocked = 'APP_COMMAND_CLEANUP_UNCONFIRMED'; finish(timeoutError()); }
        }
        try {
            op.child = launch(command, [], { shell: true, detached: platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            for (const channel of ['stdout', 'stderr']) op.child[channel]?.on('data', bytes => { op[channel] = (op[channel] + bytes.toString()).slice(0, 65536); });
            op.child.once('error', error => finish(error));
            op.child.once('exit', (code, signal) => {
                op.exited = true;
                if (!op.timedOut) finish(code === 0 ? null : Object.assign(new Error('3D launcher command failed.'), { code: 'APP_COMMAND_FAILED', exitCode: code, signal }));
            });
            if (!op.finished) timer(timeout, timeoutMs);
        } catch (error) { finish(error); }
        return true;
    }
    return { run, snapshot, isBlocked: () => !!blocked, noteRegistered: () => { if (!blocked) timeouts = 0; } };
}

module.exports = { createLogRedactor, loadConfig, certificatePath, closeReason, monitorPlayerSocket, installErrorFileLogger, createCommandRunner };
