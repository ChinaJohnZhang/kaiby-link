'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { extensionLaunch, waitForExit, stopChild, windowsNativeProbeCommand } = require('../.github/scripts/basic-smoke.cjs');

test('the Windows extension launcher preserves spaces using cmd outer and executable quotes', () => {
  const launcher = 'C:\\Users\\CI Runner\\Temp\\kaiby basic smoke abc\\launch_kaiby_link_mcp.cmd';
  const command = extensionLaunch('win32', launcher, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(command.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(command.args, ['/d', '/s', '/c', '""C:\\Users\\CI Runner\\Temp\\kaiby basic smoke abc\\launch_kaiby_link_mcp.cmd" ./app.cjs --mcp"']);
  assert.equal(command.options.windowsVerbatimArguments, true);
});

test('the Mac extension launcher passes a spaced path directly without a shell', () => {
  const launcher = '/tmp/kaiby basic smoke abc/launch_kaiby_link_mcp';
  const command = extensionLaunch('darwin', launcher);
  assert.equal(command.command, launcher); assert.deepEqual(command.args, ['./app.cjs', '--mcp']);
  assert.equal(command.options.windowsVerbatimArguments, undefined);
});

test('waiting for an already exited child resolves without missing its exit event', async () => {
  const child = new EventEmitter(); child.exitCode = 0; child.signalCode = null;
  assert.equal(await waitForExit(child, 10), 0);
  assert.equal(child.listenerCount('exit'), 0);
});

test('exit waits clean their listeners on exit, spawn failure and timeout', async () => {
  for (const mode of ['exit', 'error', 'timeout']) {
    const child = new EventEmitter(); child.exitCode = null; child.signalCode = null;
    const waiting = waitForExit(child, 5);
    if (mode === 'exit') child.emit('exit', 0);
    else if (mode === 'error') child.emit('error', new Error('fixture spawn failure'));
    if (mode === 'exit') assert.equal(await waiting, 0); else await assert.rejects(waiting);
    assert.equal(child.listenerCount('exit'), 0); assert.equal(child.listenerCount('error'), 0);
  }
});

test('MCP shutdown closes stdin before killing a Windows command parent', async () => {
  const child = new EventEmitter(); child.exitCode = null; child.signalCode = null;
  const actions = [];
  child.stdin = { destroyed: false, end() { actions.push('stdin-end'); queueMicrotask(() => { child.exitCode = 0; child.emit('exit', 0); }); }, destroy() { actions.push('stdin-destroy'); } };
  child.kill = () => actions.push('kill');
  await stopChild(child);
  assert.deepEqual(actions, ['stdin-end']);
});

test('direct runtime shutdown waits for the process to exit before cleanup', async () => {
  const child = new EventEmitter(); child.exitCode = null; child.signalCode = null; child.stdin = null;
  child.kill = () => queueMicrotask(() => { child.signalCode = 'SIGTERM'; child.emit('exit', null); });
  await stopChild(child);
  assert.equal(child.signalCode, 'SIGTERM');
});

test('an already exited command parent still closes inherited stdin for its possible Node child', async () => {
  const child = new EventEmitter(); child.exitCode = 1; child.signalCode = null;
  const actions = [];
  child.stdin = { destroyed: false, end() { actions.push('stdin-end'); }, destroy() { actions.push('stdin-destroy'); } };
  child.kill = () => actions.push('kill');
  await stopChild(child);
  assert.deepEqual(actions, ['stdin-end', 'stdin-destroy']);
});

test('the Windows native smoke compiles only the original helper C# and targets the fixture PID', () => {
  const nativeSource = 'using System;\r\npublic static class KaibyProcessFiles { public static string[] StateHomes(uint pid) { return new string[0]; } }';
  const production = "$ErrorActionPreference = 'Stop'\r\n  Add-Type -TypeDefinition @'\r\n" + nativeSource + "\r\n'@ | Out-Null\r\nGet-CimInstance Win32_Process # production discovery must not run\r\n";
  const result = windowsNativeProbeCommand(production, 12345);
  assert.equal(result.command, 'powershell.exe');
  assert.deepEqual(result.args.slice(0, -1), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  const script = Buffer.from(result.args.at(-1), 'base64').toString('utf16le');
  assert.ok(script.includes(nativeSource));
  assert.ok(script.includes('[KaibyProcessFiles]::StateHomes([uint32]12345)'));
  assert.ok(script.includes('ConvertTo-Json -InputObject $fixtureHomes -Compress'));
  assert.equal(script.includes('Get-CimInstance'), false);
  assert.equal(script.includes('ExecutionPolicy'), false); assert.equal(script.includes('Bypass'), false);
  assert.equal(script.includes('Get-Content'), false); assert.equal(script.includes('ReadAll'), false);
});

test('native smoke refuses malformed extraction or a PID that could inject PowerShell', () => {
  const source = "Add-Type -TypeDefinition @'\npublic static class KaibyProcessFiles {}\n'@";
  for (const pid of ['1); Get-Content secret', 0, -1, 1.5, NaN, 0x100000000]) assert.throws(() => windowsNativeProbeCommand(source, pid));
  assert.throws(() => windowsNativeProbeCommand(source + '\n' + source, 10), /one native helper/);
  assert.throws(() => windowsNativeProbeCommand("Add-Type -TypeDefinition @'\npublic class WrongClass {}\n'@", 10));
});
