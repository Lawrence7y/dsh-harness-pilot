import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { basename } from 'node:path';
import { resolveConfig } from '../server/runtime/config.js';
import { SessionRegistry } from '../server/runtime/sessions.js';
import { probeCdpTarget } from '../server/runtime/transports/cdp.js';

async function fixture(t, pages = [], patch = {}) {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(pages));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const config = resolveConfig({ targets: [{ name: 'fixture-gui', command: process.execPath,
    transport: 'cdp', order: ['cdp', 'window'],
    window: { title: 'Fixture GUI', process: basename(process.execPath) },
    cdp: { port, ...patch } }] });
  return { port, config, target: config.resolvedTargets.find(entry => entry.name === 'fixture-gui') };
}

const page = title => ({ id: 'page-1', type: 'page', title, url: 'app://main',
  webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/page/1' });

test('running single-instance application without an endpoint is not CDP-ready', async t => {
  const { port, target } = await fixture(t);
  const result = await probeCdpTarget(target, port);
  assert.equal(result.available, false);
  assert.match(result.detail, /already running without a matching debugging endpoint/);
});

test('a matching endpoint is attachable even if the application is already running', async t => {
  const { port, target } = await fixture(t, [page('Fixture GUI')]);
  const result = await probeCdpTarget(target, port);
  assert.equal(result.available, true);
  assert.match(result.detail, /matching debugging endpoint/);
});

test('another application on the port cannot pass endpoint ownership checks', async t => {
  const { port, target } = await fixture(t, [page('Unrelated Application')]);
  assert.equal((await probeCdpTarget(target, port)).available, false);
});

test('an application that is not running remains launchable', async t => {
  const { port, target } = await fixture(t);
  target.window.process = 'harness-pilot-nonexistent-fixture.exe';
  assert.equal((await probeCdpTarget(target, port)).available, true);
});

test('an explicitly isolated profile can be launched alongside the running application', async t => {
  const { port, target } = await fixture(t, [], { launchArgs: ['--user-data-dir=fixture-profile'] });
  assert.equal((await probeCdpTarget(target, port)).available, true);
});

test('auto selects window before sending and never retries a failed dispatch', async t => {
  const { target, config } = await fixture(t);
  const registry = new SessionRegistry({ config, helper: {
    ensure: async () => {}, find: async () => [{ title: 'Fixture GUI', hwnd: 1 }],
  } });
  const calls = [];
  registry.run = async kind => { calls.push(kind); return { transport: kind, stopReason: 'error', text: '' }; };
  const result = await registry.dispatch({ target }, { transport: 'auto' });
  assert.deepEqual(calls, ['window']);
  assert.match(result.facts.ladder, /cdp=skip/);
  assert.match(result.facts.ladder, /window=ok/);
  calls.length = 0;
  const explicit = await registry.dispatch({ target }, { transport: 'cdp' });
  assert.deepEqual(calls, []);
  assert.equal(explicit.stopReason, 'error');
});
