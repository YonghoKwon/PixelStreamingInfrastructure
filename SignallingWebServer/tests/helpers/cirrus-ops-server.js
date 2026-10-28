const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const WS = require('ws');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) { const value = fn(); if (value) return value; await pause(10); }
    throw new Error('Synthetic Cirrus integration deadline exceeded');
}
async function freePort() {
    const s = net.createServer(); await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
    const port = s.address().port; await new Promise(resolve => s.close(resolve)); return port;
}
async function start(overrides = {}, { renamed = false } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-cirrus-ops-'));
    const root = path.resolve(__dirname, '../..');
    const ports = []; while (ports.length < 3) { const p = await freePort(); if (!ports.includes(p)) ports.push(p); }
    const config = { UseFrontend: false, UseHTTPS: false, UseMatchmaker: false, UseAuthentication: false,
        LogToFile: true, LogVerbose: false, HttpPort: ports[0], StreamerPort: ports[1], SFUPort: ports[2], ...overrides };
    const configFile = path.join(dir, 'config.json'); fs.writeFileSync(configFile, JSON.stringify(config));
    let entry = path.join(root, 'cirrus_v3_codex.js');
    if (renamed) {
        // Same bytes, name changed; dependencies resolve from this worktree only.
        entry = path.join(dir, 'cirrus.js'); fs.copyFileSync(path.join(root, 'cirrus_v3_codex.js'), entry);
        fs.symlinkSync(path.join(root, 'modules'), path.join(dir, 'modules'), 'junction');
    }
    const s = { dir, config, sockets: [], logs: '', stderr: '', exit: null };
    s.child = spawn(process.execPath, ['--require', path.join(__dirname, 'cirrus-ops-launcher-preload.js'), entry, '--configFile', configFile],
        { cwd: dir, windowsHide: true, env: { ...process.env, NODE_PATH: path.join(root, 'node_modules'), CIRRUS_OPS_LAUNCH_TRACE: path.join(dir, 'launches.txt') } });
    s.child.stdout.on('data', b => { s.logs = (s.logs + b).slice(-200000); });
    s.child.stderr.on('data', b => { s.stderr = (s.stderr + b).slice(-200000); });
    s.child.once('exit', (code, signal) => { s.exit = { code, signal }; });
    s.close = async () => {
        if (s.exit === null) { s.child.kill('SIGTERM'); await until(() => s.exit !== null); }
        for (const w of s.sockets) w.terminate();
        fs.rmSync(dir, { recursive: true, force: true });
    };
    try { await until(() => s.logs.includes('Http listening') || s.exit); if (s.exit) throw Error(s.stderr); }
    catch (error) { await s.close(); throw error; }
    return s;
}
async function socket(s, port, suffix = '') {
    const w = new WS(`ws://127.0.0.1:${port}${suffix}`); w.rows = []; s.sockets.push(w);
    w.on('message', b => w.rows.push(JSON.parse(String(b)))); w.on('error', () => {});
    await new Promise((resolve, reject) => { w.once('open', resolve); w.once('error', reject); }); return w;
}
function get(s, route) {
    return new Promise((resolve, reject) => http.get(`http://127.0.0.1:${s.config.HttpPort}${route}`, r => {
        let body = ''; r.on('data', b => body += b); r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(body) }));
    }).on('error', reject));
}
module.exports = { start, socket, get, until, pause };
