import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchWindow } from '../server/runtime/transports/window.js';

function fixture({ baseline = 'Welcome', screen, submitKeys = ['enter'], source = 'uia', promptEchoGraceMs = 10000 }) {
  const target = {
    name: 'fixture-gui',
    window: { title: 'Fixture', process: 'fixture.exe', submitKeys, newlineKeys: [], openInputKeys: [], settleMs: 200, promptEchoGraceMs },
  };
  const session = { target: target.name, hwnd: 1, pid: 2, title: 'Fixture', process: 'fixture.exe',
    initialText: baseline, initialSource: source };
  const helper = {
    focus: async () => ({ focused: true }),
    call: async () => ({ foreground: { hwnd: 1 } }),
    focusInput: async () => ({ found: false, reason: 'fixture has no UIA edit control' }),
    key: async () => {},
    type: async () => {},
    text: async () => ({ text: typeof screen === 'function' ? screen() : screen, source }),
  };
  return { target, session, helper };
}

async function runDispatch(fx, prompt = 'inspect the reverse-engineering progress') {
  return dispatchWindow(fx.helper, {
    target: fx.target,
    cwd: process.cwd(),
    prompt,
    signal: new AbortController().signal,
    timeoutMs: 5000,
    onProgress: () => {},
  }, { session: fx.session });
}

test('stable navigation-only GUI snapshot cannot be reported as completed', async () => {
  const result = await runDispatch(fixture({
    baseline: 'Welcome\nWorkspace',
    screen: 'Welcome\nWorkspace\nRecent task: reverse-engineering progress',
  }));
  assert.equal(result.stopReason, 'error');
  assert.match(result.diagnostic, /prompt was not visible/);
  assert.match(result.diagnostic, /cannot verify task completion/);
});

test('UIA navigation churn without a prompt echo fails fast instead of waiting for the task timeout', async () => {
  let read = 0;
  const result = await runDispatch(fixture({
    baseline: 'Welcome\nWorkspace',
    screen: () => `Welcome\nWorkspace\nSidebar update ${++read}`,
    promptEchoGraceMs: 1000,
  }));
  assert.equal(result.stopReason, 'error');
  assert.match(result.diagnostic, /within 1000ms/);
  assert.ok(result.facts.durationMs < 5000);
});

test('stable GUI response that echoes the submitted prompt can complete', async () => {
  const result = await runDispatch(fixture({
    baseline: 'Welcome\nWorkspace',
    screen: 'Conversation\ninspect the reverse-engineering progress\nConfirmed: archive parsing is documented.',
  }));
  assert.equal(result.stopReason, 'completed');
  assert.match(result.text, /Confirmed: archive parsing is documented/);
});

test('missing submit key is an error before screen stability can imply completion', async () => {
  const result = await runDispatch(fixture({
    baseline: 'Welcome',
    screen: 'Welcome',
    submitKeys: [],
  }));
  assert.equal(result.stopReason, 'error');
  assert.match(result.diagnostic, /no submit key was sent/);
});
