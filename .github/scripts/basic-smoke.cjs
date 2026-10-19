// Runs only on disposable CI runners. It never scans an account or submits a model request.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const assert = require('node:assert/strict');
async function main() {
  const tag = process.env.RELEASE_TAG;
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(tag || '')) throw new Error('Invalid release tag');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kaiby-basic-smoke-'));
  const target = process.platform === 'win32' ? 'win-x64-setup.exe' : process.arch === 'arm64' ? 'mac-arm64.dmg' : 'mac-x64.dmg';
  let child, mount, resources, install;
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
    if (process.platform === 'win32') {
      install = path.join(temp, 'installed');
      // NSIS /D must be the final argument and is a path, not a shell expression.
      const installer = spawn(archive, ['/S', '/D=' + install], { windowsHide: true, stdio: 'ignore' });
      await new Promise((resolve, reject) => { installer.on('error', reject); installer.on('exit', code => code === 0 ? resolve() : reject(new Error('Installer failed'))); });
      resources = install;
      assert.ok(fs.existsSync(path.join(resources, 'launch.vbs')));
    } else {
      mount = path.join(temp, 'mounted'); fs.mkdirSync(mount);
      execFileSync('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, archive], { stdio: 'ignore' });
      resources = path.join(mount, 'Kaiby Link Basic.app', 'Contents', 'Resources');
      execFileSync('codesign', ['--verify', '--deep', '--strict', path.join(mount, 'Kaiby Link Basic.app')], { stdio: 'ignore' });
    }
    const runtime = path.join(resources, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
    const script = path.join(resources, 'app.cjs');
    assert.ok(fs.existsSync(script)); assert.ok(fs.existsSync(path.join(resources, 'NODE-LICENSE.txt')));
    const data = path.join(temp, 'data');
    const env = { ...process.env, KAIBY_LINK_DATA_DIR: data };
    child = spawn(runtime, [script, '--no-open'], { env, stdio: 'ignore', windowsHide: true });
    const metadataFile = path.join(data, '基础版实例.json');
    for (let n = 0; n < 100 && !fs.existsSync(metadataFile); n++) await delay(100);
    assert.ok(fs.existsSync(metadataFile)); const original = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
    const url = new URL(original.url); const headers = { Authorization: 'Bearer ' + url.hash.slice(1) };
    const state = await (await fetch(url.origin + '/api/state', { headers })).json();
    assert.equal(state.instanceId, original.instanceId); assert.equal(state.channel.authenticated, false); assert.equal(state.running, false);
    assert.equal((await fetch(url.origin + '/api/state')).status, 401);
    const page = await (await fetch(url.origin)).text(); assert.ok(page.includes('开摆连接器')); assert.ok(page.includes('kaibyai.com'));
    const second = spawn(runtime, [script, '--no-open'], { env, stdio: 'ignore', windowsHide: true });
    await new Promise((resolve, reject) => { second.on('error', reject); second.on('exit', code => code === 0 ? resolve() : reject(new Error('Second launch failed'))); });
    assert.equal(JSON.parse(fs.readFileSync(metadataFile, 'utf8')).instanceId, original.instanceId);
    await fetch(url.origin + '/api/shutdown', { method: 'POST', headers });
    await new Promise((resolve, reject) => { if (child.exitCode !== null) return resolve(); const timer = setTimeout(() => reject(new Error('Service did not exit')), 8000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
    assert.equal(fs.existsSync(metadataFile), false);
    assert.equal(fs.existsSync(path.join(data, '基础版启动.lock')), false);
    console.log('Verified installer hash, runtime startup, local UI, access control, single instance and shutdown on ' + process.platform + '/' + process.arch + '. No account or model requests.');
  } finally {
    if (child?.exitCode === null) child.kill();
    if (mount) try { execFileSync('hdiutil', ['detach', mount], { stdio: 'ignore' }); } catch {}
    if (install && fs.existsSync(path.join(install, 'Uninstall.exe'))) {
      const uninstaller = spawn(path.join(install, 'Uninstall.exe'), ['/S'], { stdio: 'ignore', windowsHide: true });
      await new Promise(resolve => uninstaller.once('exit', resolve));
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(() => { console.error('Basic installer smoke test failed; inspect the failed stage without printing local credentials.'); process.exitCode = 1; });
