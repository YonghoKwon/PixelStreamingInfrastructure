// Executes the complete entry point with in-memory network/process adapters.
// No real sockets, child processes, certificates or configuration writes are used.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function createHarness(overrides = {}) {
    let now = 1000000;
    const timers = new Set();
    const commands = [];
    const logs = [];
    const servers = [];
    const schedule = (fn, delay, interval = false) => {
        const timer = { fn, delay, next: now + delay, interval, active: true, unref() { return this; } };
        timers.add(timer);
        return timer;
    };
    const cancel = timer => { if (timer) { timer.active = false; timers.delete(timer); } };
    function advance(milliseconds) {
        const end = now + milliseconds;
        let iterations = 0;
        for (;;) {
            const next = [...timers].filter(t => t.active && t.next <= end).sort((a, b) => a.next - b.next)[0];
            if (!next) break;
            if (++iterations > 100000) throw new Error('Runaway fake timer');
            now = next.next;
            if (next.interval) next.next += next.delay;
            else cancel(next);
            next.fn();
        }
        now = end;
    }
    class FakeSocket extends EventEmitter {
        constructor() {
            super();
            this.readyState = 1;
            this.sent = [];
            this.closeCalls = [];
            this.terminateCalls = 0;
            this._socket = { remoteAddress: '::ffff:127.0.0.1' };
        }
        send(raw, callback) {
            if (this.readyState !== 1) throw new Error('Socket is not open');
            if (this.failSend) { if (callback) callback(new Error('simulated send failure')); return; }
            this.sent.push(JSON.parse(raw));
            if (callback) callback();
        }
        close(code = 1000, reason = '') {
            this.closeCalls.push({ code, reason });
            if (this.readyState === 3) return;
            this.readyState = 2;
        }
        finishClose(code = 1000, reason = '') {
            if (this.readyState === 3) return;
            this.readyState = 3;
            this.emit('close', code, Buffer.from(reason));
        }
        terminate() { this.terminateCalls++; this.finishClose(1006); }
        message(payload) { this.emit('message', typeof payload === 'string' ? payload : JSON.stringify(payload)); }
    }
    class FakeServer extends EventEmitter {
        constructor(options) { super(); this.options = options; this.clients = new Set(); servers.push(this); }
        listen(port, callback) { this.port = port; if (callback) callback(); return this; }
        close(callback) { this.closed = true; if (callback) callback(); }
    }
    class FakeWebSocket {}
    Object.assign(FakeWebSocket, { OPEN: 1, CLOSING: 2, CLOSED: 3, CONNECTING: 0, Server: FakeServer });
    const app = { routes: [], use(...args) { this.routes.push(args); },
        get(...args) { this.routes.push(args); }, post(...args) { this.routes.push(args); } };
    const express = () => app;
    express.static = () => () => {};
    const middlewareFactory = () => () => {};
    const fakeProcess = new EventEmitter();
    Object.assign(fakeProcess, { platform: 'win32', env: {}, uptime: () => (now - 1000000) / 1000,
        exit(code) { this.exitCode = code; this.exited = true; } });
    const fakeFs = {
        existsSync() { return true; },
        readFileSync(file, encoding) {
            let content;
            if (String(file).endsWith('.json')) content = JSON.stringify(overrides);
            else if (String(file).includes('chain')) content = '-----BEGIN CERTIFICATE-----\nINTERMEDIATE\n-----END CERTIFICATE-----';
            else content = '-----BEGIN CERTIFICATE-----\nLEAF\n-----END CERTIFICATE-----';
            return encoding ? content : Buffer.from(content);
        }
    };
    const fakeExec = (command, options, callback) => {
        if (typeof options === 'function') { callback = options; options = {}; }
        const operation = { command, options, done: false, callback: null, child: { pid: commands.length + 1 } };
        const timeout = options.timeout ? schedule(() => operation.callback(new Error('simulated command timeout')), options.timeout) : null;
        operation.callback = error => {
            if (operation.done) return;
            operation.done = true;
            cancel(timeout);
            callback(error || null, '', '');
        };
        commands.push(operation);
        return operation.child;
    };
    const dependencies = {
        express, fs: fakeFs, path, querystring: require('node:querystring'),
        'body-parser': { urlencoded: middlewareFactory },
        './modules/logging.js': { RegisterConsoleLogger() {}, RegisterFileLogger() {} },
        './modules/config.js': { init(file, defaults) { return { ...defaults, ...overrides }; } },
        yargs: { argv: {} }, http: { Server: function () { return new FakeServer(); } },
        https: { Server: function (options) { return new FakeServer(options); } },
        helmet: middlewareFactory, hsts: middlewareFactory, 'express-rate-limit': middlewareFactory,
        net: { Socket: class extends EventEmitter { connect() { this.emit('connect'); } setKeepAlive() {} write() {} } },
        'child_process': { exec: fakeExec }, ws: FakeWebSocket, url: require('node:url')
    };
    const context = vm.createContext({
        require(name) {
            if (!(name in dependencies)) throw new Error('Unexpected dependency: ' + name);
            return dependencies[name];
        },
        console: Object.fromEntries(['log', 'warn', 'error', 'logColor'].map(name => [name, (...args) => logs.push({ name, args })])),
        process: fakeProcess, Buffer, URLSearchParams,
        __dirname: path.resolve(__dirname, '../..'),
        Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } },
        setTimeout: (fn, delay) => schedule(fn, delay), clearTimeout: cancel,
        setInterval: (fn, delay) => schedule(fn, delay, true), clearInterval: cancel
    });
    const file = path.resolve(__dirname, '../../cirrus_v2_codex.js');
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    const run = code => vm.runInContext(code, context);
    function connect(serverName, url = '/') {
        const socket = new FakeSocket();
        context.nextSocket = socket;
        context.nextRequest = { url, connection: { remoteAddress: '127.0.0.1' } };
        run(serverName + '.clients.add(nextSocket)');
        const server = run(serverName);
        socket.once('close', () => server.clients.delete(socket));
        run(serverName + '.emit("connection", nextSocket, nextRequest)');
        return socket;
    }
    function streamer(id = 'A') {
        const socket = connect('streamerServer');
        if (id !== null) socket.message({ type: 'endpointId', id });
        return socket;
    }
    return {
        advance, commands, logs, servers, run, app, process: fakeProcess,
        player: url => connect('playerServer', url), streamer,
        sfu() { const socket = connect('sfuServer'); socket.message({ type: 'endpointId', id: 'SFU' }); return socket; },
        playerId(socket) { context.selectedSocket = socket; return run('[...players.values()].find(p => p.ws === selectedSocket).id'); },
        count: () => run('browserPlayerCount()'),
        complete: (index = commands.length - 1, error) => commands[index].callback(error)
    };
}

module.exports = { createHarness };
