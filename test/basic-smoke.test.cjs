'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { extensionLaunch, waitForExit, stopChild, windowsNativeProbeCommand, diagnosticText, failureDiagnostic, failureAnnotation, observeChild } = require('../.github/scripts/basic-smoke.cjs');

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

test('smoke diagnostics retain compiler errors while redacting credentials, encoded commands and local paths', () => {
  const raw = [
    'Add-Type : error CS1061: fixture native helper failed',
    'Authorization: Bearer fixture-bearer-value', 'token="fixture-local-token"',
    'https://user:fixture-password@127.0.0.1:61554/#fixture-access-fragment',
    'https://example.test/download?secret=fixture-query-secret',
    'C:\\Users\\CI Runner\\Temp\\fixture private\\state_99.sqlite',
    '/Users/fixture-person/private/state_99.sqlite',
    'powershell.exe -EncodedCommand ' + 'Q'.repeat(512),
  ].join('\n');
  const safe = diagnosticText(raw);
  assert.match(safe, /CS1061: fixture native helper failed/);
  assert.match(safe, /127\.0\.0\.1:61554/);
  assert.match(safe, /\[local path\]/);
  for (const secret of ['fixture-bearer-value', 'fixture-local-token', 'fixture-password', 'fixture-access-fragment',
    'fixture-query-secret', 'fixture private', 'fixture-person', 'Q'.repeat(64)]) assert.equal(safe.includes(secret), false, secret);
});

test('failure diagnostics retain their original stage, native process status and bounded stderr', () => {
  const error = new Error('Native fixture process failed');
  error.smokeStage = 'Windows native helper: compile and query fixture handles';
  error.code = 'ETIMEDOUT'; error.status = 1; error.signal = 'SIGTERM';
  error.stderr = Buffer.from('#< CLIXML\r\n<Objs><S S="Error">Add-Type : error CS1002_x000D__x000A_token=fixture-private-token</S></Objs>');
  error.stdout = Buffer.from('x'.repeat(4096));
  const diagnostic = failureDiagnostic(error);
  assert.equal(diagnostic.stage, error.smokeStage);
  assert.equal(diagnostic.code, 'ETIMEDOUT'); assert.equal(diagnostic.status, 1); assert.equal(diagnostic.signal, 'SIGTERM');
  assert.match(diagnostic.stderr, /Add-Type : error CS1002/);
  assert.equal(JSON.stringify(diagnostic).includes('fixture-private-token'), false);
  assert.ok(diagnostic.stdout.length <= 1800);
});

test('assertion arrays and process output diagnostics do not dump fixture paths or access URLs', () => {
  const error = new assert.AssertionError({ message: 'Native helper directory count mismatch', actual: ['C:\\Users\\private-user\\fixture'], expected: [], operator: 'deepStrictEqual' });
  const diagnostic = failureDiagnostic(error);
  assert.equal(diagnostic.actual, 'Array(1)'); assert.equal(diagnostic.expected, 'Array(0)');
  assert.equal(JSON.stringify(diagnostic).includes('private-user'), false);
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = 1; child.signalCode = null;
  const report = observeChild(child, 'fixture runtime');
  child.stdout.write('http://127.0.0.1:12345/#fixture-browser-secret\n');
  child.stderr.write('runtime startup failed: token=fixture-child-secret\n');
  const output = report();
  assert.equal(output.exitCode, 1); assert.match(output.stderr, /runtime startup failed/);
  assert.equal(JSON.stringify(output).includes('fixture-browser-secret'), false);
  assert.equal(JSON.stringify(output).includes('fixture-child-secret'), false);
});

test('GitHub failure annotations contain the phase and escaped sanitized reason', () => {
  const error = new Error('Native fixture failed at 50%\nsecond line');
  error.smokeStage = 'Windows native helper'; error.status = 1;
  error.stderr = 'error CS1061\r\ntoken=fixture-annotation-secret';
  const annotation = failureAnnotation(error);
  assert.match(annotation, /^::error title=便携包验证::Windows native helper/);
  assert.match(annotation, /50%25/); assert.match(annotation, /%0Aerror CS1061%0D%0A/);
  assert.equal(annotation.includes('fixture-annotation-secret'), false);
  assert.equal(annotation.includes('\n'), false); assert.equal(annotation.includes('\r'), false);
});
