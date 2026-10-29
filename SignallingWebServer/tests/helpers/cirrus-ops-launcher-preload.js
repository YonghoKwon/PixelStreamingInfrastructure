// Local integration tests must never call an operating launcher, even on failure.
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
require('node:child_process').spawn = (command) => {
    const child = Object.assign(new EventEmitter(), { pid: 6000, stdout: new EventEmitter(), stderr: new EventEmitter() });
    fs.appendFileSync(process.env.CIRRUS_OPS_LAUNCH_TRACE, /restart|Start_/.test(command) ? 'START\n' : 'STOP\n');
    child.kill = () => true;
    setImmediate(() => child.emit('exit', 1, null));
    return child;
};
