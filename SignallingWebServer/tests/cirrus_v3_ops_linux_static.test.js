const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('three Linux setup scripts statically select Node 24 gzip archive and preserve existing node folder', () => {
    for (const component of ['SignallingWebServer', 'SFU', 'Matchmaker']) {
        const source = fs.readFileSync(path.resolve(__dirname, '../..', component, 'platform_scripts/bash/setup.sh'), 'utf8');
        assert.match(source, /if \[\[ -d "\$\{BASH_LOCATION\}\/node" \]\]; then/);
        assert.match(source, /curl -fL https:\/\/nodejs\.org\/dist\/v24\.22\.1\/node-v24\.22\.1-linux-x64\.tar\.gz --output node\.tar\.gz/);
        assert.match(source, /tar -xzf node\.tar\.gz/);
        assert.match(source, /mv node-v24\.22\.1-linux-x64/);
        assert.ok(!source.includes('v18.17.0'));
    }
});
