const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const scripts = path.resolve(__dirname, '../../scripts');
const powershell = 'powershell.exe';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let scriptSequence = 0;

async function runScript(fixture, name, args = []) {
  const sequence = ++scriptSequence;
  const outPath = path.join(fixture, `test-command-${sequence}.out`);
  const errPath = path.join(fixture, `test-command-${sequence}.err`);
  const stdout = await fs.open(outPath, 'w');
  const stderr = await fs.open(errPath, 'w');
  try {
    // A detached Windows child may inherit pipe handles; wait for PowerShell's exit.
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(fixture, 'scripts', name), ...args], {
      windowsHide: true,
      stdio: ['ignore', stdout.fd, stderr.fd],
    });
    const code = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error(`${name} timed out`)); }, 90_000);
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('exit', (value) => { clearTimeout(timeout); resolve(value); });
    });
    return { code, stdout: await fs.readFile(outPath, 'utf8'), stderr: await fs.readFile(errPath, 'utf8') };
  } finally {
    await stdout.close();
    await stderr.close();
  }
}

async function availablePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

async function response(port) {
  const res = await fetch(`http://127.0.0.1:${port}/dashboard`, { signal: AbortSignal.timeout(2_000) });
  return res.json();
}

test('desktop launcher isolates ownership, honors PORT and reuses the server on Windows', { skip: process.platform !== 'win32', timeout: 150_000 }, async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), '9router launcher & fixture-'));
  const fixtureScripts = path.join(fixture, 'scripts');
  await fs.mkdir(fixtureScripts);
  for (const file of ['start-9router.ps1', 'stop-9router.ps1', 'launcher-common.ps1']) {
    await fs.copyFile(path.join(scripts, file), path.join(fixtureScripts, file));
  }
  // This server has no app imports, provider calls, database access or shared state.
  const serverSource = `const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
fs.appendFileSync(path.join(__dirname, 'fixture-starts.log'), String(process.pid) + '\\n');
setTimeout(() => http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ pid: process.pid, port })); }).listen(port, '127.0.0.1'), 1500);
`;
  await fs.writeFile(path.join(fixture, 'custom-server.js'), serverSource);
  let foreign;
  const port = await availablePort();
  await fs.writeFile(path.join(fixture, '.env'), `PORT="${port}" # fixture port\n`);
  try {
    await t.test('concurrent clicks start once on .env port and -NoBrowser supports reuse', async () => {
      const starts = await Promise.all([
        runScript(fixture, 'start-9router.ps1', ['-NoBrowser']),
        runScript(fixture, 'start-9router.ps1', ['-NoBrowser']),
      ]);
      for (const result of starts) assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.equal(starts.filter((result) => /already running/.test(result.stdout)).length, 1);
      const initial = await response(port);
      assert.equal(initial.port, port);
      assert.deepEqual((await fs.readFile(path.join(fixture, 'fixture-starts.log'), 'utf8')).trim().split('\n'), [String(initial.pid)]);
      const again = await runScript(fixture, 'start-9router.ps1', ['-NoBrowser']);
      assert.equal(again.code, 0, again.stdout + again.stderr);
      assert.match(again.stdout, /already running/);
      assert.equal((await response(port)).pid, initial.pid);
    });

    await t.test('stop terminates only the verified fixture server', async () => {
      const stopped = await runScript(fixture, 'stop-9router.ps1');
      assert.equal(stopped.code, 0, stopped.stdout + stopped.stderr);
      assert.match(stopped.stdout, /Stopped 9Router/);
      await assert.rejects(response(port));
      const again = await runScript(fixture, 'stop-9router.ps1');
      assert.equal(again.code, 0, again.stdout + again.stderr);
      assert.match(again.stdout, /not running/);
    });

    await t.test('foreign node stays alive and start refuses to reuse it', async () => {
      const foreignFile = path.join(fixture, 'foreign-server.js');
      await fs.writeFile(foreignFile, serverSource);
      // Include the owned path in a later argument to catch unsafe substring matching.
      foreign = spawn(process.execPath, [foreignFile, '--port', String(port), path.join(fixture, 'custom-server.js')], { windowsHide: true, stdio: 'ignore' });
      for (let attempt = 0; attempt < 30; attempt++) {
        try { await response(port); break; } catch { await sleep(100); }
      }
      assert.equal((await response(port)).pid, foreign.pid);
      const started = await runScript(fixture, 'start-9router.ps1', ['-NoBrowser']);
      assert.equal(started.code, 1, started.stdout + started.stderr);
      assert.match(started.stdout, /cannot be verified/);
      const stopped = await runScript(fixture, 'stop-9router.ps1');
      assert.equal(stopped.code, 1, stopped.stdout + stopped.stderr);
      assert.match(stopped.stdout, /Leaving it alone/);
      assert.equal((await response(port)).pid, foreign.pid);
    });

    await t.test('invalid PORT fails without launching a server', async () => {
      await fs.writeFile(path.join(fixture, '.env'), 'PORT=70000\n');
      const result = await runScript(fixture, 'start-9router.ps1', ['-NoBrowser']);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /PORT in .env must be an integer/);
      assert.equal((await response(port)).pid, foreign.pid);
    });

    await t.test('ownership matching rejects relative scripts and mocked recycled PIDs', async () => {
      const checks = `$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'launcher-common.ps1')
$repo = Split-Path -Parent $PSScriptRoot
$entrypoint = Join-Path $repo 'custom-server.js'
$ownedCommand = '"C:\\Program Files\\nodejs\\node.exe" "' + $entrypoint + '" --port 1234'
if (-not (Test-9RouterProcessOwnership ([pscustomobject]@{ Name = 'node.exe'; CommandLine = $ownedCommand }) $repo)) { throw 'owned rejected' }
foreach ($cmd in @('node custom-server.js --port 1234', ('node --eval "' + $entrypoint + '"'), ('node "' + $entrypoint + '.bak"'))) {
    if (Test-9RouterProcessOwnership ([pscustomobject]@{ Name = 'node.exe'; CommandLine = $cmd }) $repo) { throw 'foreign accepted' }
}
$script:didStop = $false
function Stop-Process { $script:didStop = $true }
function Get-CimInstance { [pscustomobject]@{ Name = 'node.exe'; CommandLine = $ownedCommand; CreationDate = [datetime]'2026-09-15T02:00:00Z' } }
$stale = [pscustomobject]@{ ProcessId = 999999; Owned = $true; CreationDate = [datetime]'2026-09-15T01:00:00Z' }
if (Stop-9RouterOwnedProcess $stale $repo) { throw 'recycled PID accepted' }
if ($script:didStop) { throw 'recycled PID stopped' }
Write-Output 'ownership checks passed'
`;
      await fs.writeFile(path.join(fixtureScripts, 'ownership-checks.ps1'), checks);
      const result = await runScript(fixture, 'ownership-checks.ps1');
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /ownership checks passed/);
    });
  } finally {
    if (foreign) {
      if (foreign.exitCode === null && foreign.signalCode === null) {
        const exited = new Promise((resolve) => foreign.once('exit', resolve));
        foreign.kill();
        await exited;
      }
    }
    await fs.writeFile(path.join(fixture, '.env'), `PORT=${port}\n`);
    const cleanup = await runScript(fixture, 'stop-9router.ps1');
    // Retain the isolated fixture for inspection if ownership-safe cleanup fails.
    assert.equal(cleanup.code, 0, cleanup.stdout + cleanup.stderr);
    // mkdtemp supplies this resolved child of the system temp directory.
    assert.equal(path.dirname(path.resolve(fixture)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(fixture).startsWith('9router launcher & fixture-'));
    await fs.rm(fixture, { recursive: true, force: true });
  }
});
