// Runs only on disposable CI runners. It never scans an account or submits a model request.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const assert = require('node:assert/strict');
function extensionLaunch(platform, launcher, comspec = process.env.ComSpec || 'cmd.exe') {
  return platform === 'win32'
    // cmd /s removes the outer pair, leaving the quoted executable path.
    // Verbatim arguments prevent Node from escaping these cmd quotes again.
    ? { command: comspec, args: ['/d', '/s', '/c', '""' + launcher + '" ./app.cjs --mcp"'], options: { windowsVerbatimArguments: true, windowsHide: true } }
    : { command: launcher, args: ['./app.cjs', '--mcp'], options: {} };
}
function waitForExit(child, milliseconds = 5000) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const finish = (error, code) => { clearTimeout(timer); child.off('exit', exited); child.off('error', errored); error ? reject(error) : resolve(code); };
    const exited = code => finish(null, code), errored = error => finish(error);
    const timer = setTimeout(() => finish(new Error('Child process exit timeout')), milliseconds);
    child.once('exit', exited); child.once('error', errored);
    // Covers an exit occurring between the initial state check and listeners.
    if (child.exitCode != null || child.signalCode != null) finish(null, child.exitCode);
  });
}
async function stopChild(child) {
  if (!child) return;
  // Closing stdin reaches the Node child of a Windows .cmd launcher too.
  // Killing only cmd.exe first could orphan that Node process and lock the ZIP.
  if (child.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
  if (child.exitCode != null || child.signalCode != null) { child.stdin?.destroy(); return; }
  if (child.stdin && !child.stdin.destroyed) {
    try { await waitForExit(child, 1500); return; } catch {}
    child.stdin.destroy();
  }
  child.kill();
  await waitForExit(child, 1500).catch(() => {});
}
function windowsNativeProbeCommand(helperSource, fixturePid) {
  assert.ok(Number.isInteger(fixturePid) && fixturePid > 0 && fixturePid <= 0xffffffff, 'Invalid fixture PID');
  const blocks = [...helperSource.matchAll(/(?:^|\r?\n)[ \t]*Add-Type[ \t]+-TypeDefinition[ \t]+@'\r?\n([\s\S]*?)\r?\n'@/g)];
  assert.equal(blocks.length, 1, 'Expected one native helper C# block');
  const nativeSource = blocks[0][1];
  assert.match(nativeSource, /public\s+(?:static\s+)?class\s+KaibyProcessFiles\b/);
  // Compile exactly the C# shipped in the ZIP, without running the production
  // script's desktop discovery. The sole target is this CI Node process, which
  // holds an empty, disposable state filename. No file contents are requested.
  const script = [
    "$ErrorActionPreference = 'Stop'", "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    "Add-Type -TypeDefinition @'", nativeSource, "'@ | Out-Null",
    `$fixtureHomes = @([KaibyProcessFiles]::StateHomes([uint32]${fixturePid}))`,
    'ConvertTo-Json -InputObject $fixtureHomes -Compress',
  ].join('\n');
  return { command: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] };
}
function checkWindowsNativeHelper(resources, temp, env) {
  assert.equal(process.platform, 'win32', 'Native helper fixture requires Windows');
  const directory = fs.mkdtempSync(path.join(temp, 'native handle fixture '));
  const fd = fs.openSync(path.join(directory, 'state_99.sqlite'), 'wx', 0o600);
  try {
    const source = fs.readFileSync(path.join(resources, 'discovery-windows.ps1'), 'utf8');
    const probe = windowsNativeProbeCommand(source, process.pid);
    const raw = execFileSync(probe.command, probe.args, { env, encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    const homes = JSON.parse(raw.trim().replace(/^\uFEFF/, ''));
    assert.ok(Array.isArray(homes), 'Native helper must return a directory array');
    assert.equal(homes.length, 1, 'Native helper must find exactly the fixture directory');
    assert.equal(typeof homes[0], 'string');
    assert.equal(path.resolve(homes[0]).toLowerCase(), fs.realpathSync(directory).toLowerCase(), 'Native helper returned a different directory');
  } finally {
    fs.closeSync(fd); fs.rmSync(directory, { recursive: true, force: true });
  }
}
async function checkDesktopExtension(resources, runtime, env, version) {
  const root = path.join(resources, 'marketplace', 'extension');
  const marketplace = JSON.parse(fs.readFileSync(path.join(resources, 'marketplace', '.agents', 'plugins', 'marketplace.json')));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.codex-plugin', 'plugin.json')));
  const config = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json')));
  assert.equal(marketplace.name, 'kaiby-link-local'); assert.equal(manifest.version, version);
  assert.ok(Object.values(config.mcpServers).some(s => s.env_vars.includes('CODEX_APP_TOOLS_PIPE_PATH')));
  const launcher = path.join(root, process.platform === 'win32' ? 'launch_kaiby_link_mcp.cmd' : 'launch_kaiby_link_mcp');
  // The bundled runtime substitutes for the desktop runtime only in this
  // protocol smoke test. No desktop identity or actual account is simulated.
  const childEnv = { ...env, CODEX_MCP_NODE_PATH: runtime };
  const launch = extensionLaunch(process.platform, launcher);
  const child = spawn(launch.command, launch.args, { ...launch.options, cwd: root, env: childEnv, stdio: ['pipe','pipe','ignore'] });
  let text = '', failure; const received = new Map();
  child.on('error', error => { failure = error; });
  child.stdin.on('error', error => { failure = error; });
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => {
    text += chunk; if (text.length > 1024 * 1024) { failure = new Error('MCP output too large'); child.stdin.end(); return; }
    let end; while ((end = text.indexOf('\n')) >= 0) { const row = text.slice(0,end); text = text.slice(end+1); if (row.trim()) try { const msg=JSON.parse(row);received.set(msg.id,msg); } catch { failure=new Error('Non-protocol stdout'); } }
  });
  async function request(id, method, params) {
    if (failure) throw failure;
    assert.equal(child.exitCode, null, 'MCP exited before request');
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
    for(let i=0;i<100&&!received.has(id)&&!failure&&child.exitCode===null;i++) await delay(50);
    if(failure) throw failure; assert.ok(received.has(id),'MCP response missing'); return received.get(id);
  }
  try {
    assert.equal((await request(1,'initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'portable-smoke',version:'1'}})).result.serverInfo.version,version);
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    const tools=(await request(2,'tools/list',{})).result.tools;
    assert.deepEqual(tools.map(t=>t.name),['enable_kaiby_link']);
    assert.equal((await request(3,'tools/call',{name:'enable_kaiby_link',arguments:{}})).result.isError,true);
    child.stdin.end();
    assert.equal(await waitForExit(child), 0, 'MCP exit failed');
  } finally { await stopChild(child); }
}
async function main() {
  const tag = process.env.RELEASE_TAG;
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(tag || '')) throw new Error('Invalid release tag');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kaiby basic smoke '));
  const target = process.platform === 'win32' ? 'win-x64.zip' : process.arch === 'arm64' ? 'mac-arm64.zip' : 'mac-x64.zip';
  let child, second, resources;
  try {
    const response = await fetch('https://api.github.com/repos/ChinaJohnZhang/kaiby-link/releases/tags/' + tag, { headers: { 'User-Agent': 'Kaiby-Link-Smoke', ...(process.env.GITHUB_TOKEN ? { Authorization: 'Bearer ' + process.env.GITHUB_TOKEN } : {}) } });
    assert.equal(response.status, 200); const release = await response.json();
    const asset = release.assets.find(a => a.name.endsWith(target));
    const checksum = release.assets.find(a => a.name === 'SHA256SUMS.txt'); assert.ok(asset && checksum);
    const sums = await (await fetch(checksum.browser_download_url)).text();
    const expected = sums.split(/\r?\n/).map(s => s.trim().split(/\s+/)).find(parts => parts[1] === asset.name)?.[0];
    assert.match(expected || '', /^[a-f0-9]{64}$/);
    const bytes = Buffer.from(await (await fetch(asset.browser_download_url)).arrayBuffer());
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), expected);
    const archive = path.join(temp, asset.name); fs.writeFileSync(archive, bytes);
    const extracted = path.join(temp, 'extracted');
    if (process.platform === 'win32') execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:KAIBY_TEST_ARCHIVE -DestinationPath $env:KAIBY_TEST_EXTRACT -Force'], { stdio: 'ignore', env: { ...process.env, KAIBY_TEST_ARCHIVE: archive, KAIBY_TEST_EXTRACT: extracted } });
    else execFileSync('unzip', ['-q', archive, '-d', extracted], { stdio: 'ignore' });
    resources = path.join(extracted, 'Kaiby-Link-Basic');
    assert.ok(fs.existsSync(path.join(resources, process.platform === 'win32' ? '启动开摆连接器.cmd' : '启动开摆连接器.command')));
    const runtime = path.join(resources, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
    const script = path.join(resources, 'app.cjs');
    assert.ok(fs.existsSync(script)); assert.ok(fs.existsSync(path.join(resources, 'NODE-LICENSE.txt')));
    const data = path.join(temp, 'data');
    const env = { ...process.env, KAIBY_LINK_DATA_DIR: data };
    for(const key of ['CODEX_APP_TOOLS_PIPE_PATH','CODEX_MCP_NODE_PATH','CODEX_BROWSER_USE_NODE_PATH','CODEX_ELECTRON_RESOURCES_PATH','CODEX_CLI_PATH','CODEX_HOME','CODEX_THREAD_ID','CODEX_APP_TOOLS_CALLER_HOST_ID']) delete env[key];
    if (process.platform === 'win32') checkWindowsNativeHelper(resources, temp, env);
    await checkDesktopExtension(resources,runtime,env,tag.slice(1));
    child = spawn(runtime, [script, '--no-open'], { env, stdio: 'ignore', windowsHide: true });
    const metadataFile = path.join(data, '基础版实例.json');
    for (let n = 0; n < 100 && !fs.existsSync(metadataFile); n++) await delay(100);
    assert.ok(fs.existsSync(metadataFile)); const original = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
    const url = new URL(original.url); const headers = { Authorization: 'Bearer ' + url.hash.slice(1) };
    const state = await (await fetch(url.origin + '/api/state', { headers })).json();
    assert.equal(state.instanceId, original.instanceId); assert.equal(state.channel.authenticated, false); assert.equal(state.running, false);
    assert.equal(state.codex.ready,false); assert.equal(state.codex.source,'desktop');
    assert.equal((await fetch(url.origin + '/api/state')).status, 401);
    const page = await (await fetch(url.origin)).text(); assert.ok(page.includes('开摆连接器')); assert.ok(page.includes('kaibyai.com'));
    second = spawn(runtime, [script, '--no-open'], { env, stdio: 'ignore', windowsHide: true });
    assert.equal(await waitForExit(second), 0, 'Second launch failed');
    assert.equal(JSON.parse(fs.readFileSync(metadataFile, 'utf8')).instanceId, original.instanceId);
    await fetch(url.origin + '/api/shutdown', { method: 'POST', headers });
    await waitForExit(child, 8000);
    assert.equal(fs.existsSync(metadataFile), false);
    assert.equal(fs.existsSync(path.join(data, '基础版启动.lock')), false);
    console.log('Verified portable ZIP hash, extraction, ' + (process.platform === 'win32' ? 'native Windows handle helper fixture, ' : '') + 'extension launcher/MCP protocol, runtime startup, local UI, access control, single instance and shutdown on ' + process.platform + '/' + process.arch + '. No actual desktop, account or model requests.');
  } finally {
    await stopChild(second); await stopChild(child);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
if (require.main === module) main().catch(() => { console.error('Basic portable package smoke test failed; inspect the failed stage without printing local credentials.'); process.exitCode = 1; });
module.exports = { extensionLaunch, waitForExit, stopChild, checkDesktopExtension, windowsNativeProbeCommand };
