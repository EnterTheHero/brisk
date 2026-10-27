// Starts Electron with the real-input test and records everything it prints.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const out = path.resolve('wout');
fs.mkdirSync(out, { recursive: true });
const exe = require('electron'); // path to electron.exe
const logf = path.join(out, 'run.txt');
fs.writeFileSync(logf, `exe ${exe}\n`);
function run(extra) {
  return new Promise((done) => {
    const p = spawn(exe, [path.join(__dirname, 'real-input.js'), `--out=${out}`, ...extra], { env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' } });
    p.stdout.on('data', (d) => fs.appendFileSync(logf, d));
    p.stderr.on('data', (d) => fs.appendFileSync(logf, d));
    const kill = setTimeout(() => { fs.appendFileSync(logf, '\nTIMEOUT\n'); p.kill(); }, 200000);
    p.on('exit', (code, sig) => { clearTimeout(kill); fs.appendFileSync(logf, `\nexit ${code} ${sig}\n`); done(); });
  });
}
(async () => { await run(['--left', '--dashlane']); await run(['--dashlane']); })();
