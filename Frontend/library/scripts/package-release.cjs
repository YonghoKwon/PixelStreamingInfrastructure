const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const source = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(source.version)) throw new Error('Use an unused stable patch version for the internal registry release.');
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run npm run package:release.');
const buildRoot = path.join(root, 'build');
fs.mkdirSync(buildRoot, { recursive: true });
const stage = fs.mkdtempSync(path.join(buildRoot, 'release-package-'));
const output = path.join(stage, 'packed');
fs.mkdirSync(output);

function copyText(from, to) {
  fs.writeFileSync(to, fs.readFileSync(from, 'utf8').replace(/\r\n/g, '\n'), { mode: 0o644 });
  fs.chmodSync(to, 0o644);
}
function copyTree(from, to, accept) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name), b = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(a, b, accept);
    else if (entry.isFile() && accept(entry.name)) copyText(a, b);
    else if (!entry.isFile()) throw new Error('Unsupported release entry: ' + a);
  }
}
fs.mkdirSync(path.join(stage, 'dist'));
for (const file of ['lib-pixelstreamingfrontend.js', 'lib-pixelstreamingfrontend.esm.js']) {
  copyText(path.join(root, 'dist', file), path.join(stage, 'dist', file));
}
copyTree(path.join(root, 'types'), path.join(stage, 'types'), file => file.endsWith('.d.ts'));
const docs = ['LICENSE.md', 'readme.md', 'IME.md', 'UPSTREAM.md', 'NEXUS.md'];
for (const file of docs) copyText(path.join(root, file), path.join(stage, file));
const manifest = {};
for (const key of ['name', 'version', 'description', 'main', 'module', 'types', 'sideEffects', 'author', 'license', 'dependencies']) manifest[key] = source[key];
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');

const result = spawnSync(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', output], { cwd: stage, encoding: 'utf8' });
if (result.status !== 0) throw new Error(result.stderr || 'npm pack failed');
const pack = JSON.parse(result.stdout)[0];
const names = pack.files.map(file => file.path);
const allowed = file => !/(?:^|\/)__tests?__\/|\.test\.d\.ts$/.test(file) && (file === 'package.json' || docs.includes(file) ||
  /^dist\/lib-pixelstreamingfrontend(?:\.esm)?\.js$/.test(file) ||
  (file.startsWith('types/') && file.endsWith('.d.ts')));
if (names.some(file => !allowed(file))) throw new Error('Unexpected release contents: ' + names.filter(file => !allowed(file)).join(', '));
for (const entry of [manifest.main, manifest.module, manifest.types, 'LICENSE.md']) {
  if (!names.includes(entry)) throw new Error('Missing runtime/type entry: ' + entry);
}
if (manifest.private || manifest.scripts || manifest.publishConfig) throw new Error('Release must not contain source-only publish/build configuration.');
const bytes = fs.readFileSync(path.join(output, pack.filename));
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
const artifacts = path.join(root, 'artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const target = path.join(artifacts, pack.filename);
if (fs.existsSync(target) && crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') !== sha256) {
  throw new Error('Different artifact already exists for this version; use a new release version.');
}
fs.writeFileSync(target, bytes);
const receipt = { name: manifest.name, version: manifest.version, filename: pack.filename, sha256, integrity: pack.integrity, size: bytes.length, files: names };
fs.writeFileSync(path.join(artifacts, 'release-manifest.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ artifact: target, version: receipt.version, sha256, integrity: receipt.integrity, files: names.length }, null, 2));
