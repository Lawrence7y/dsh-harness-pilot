import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listHarnessModels } from '../server/runtime/models.js';

test('read-only model discovery retries one empty successful launch', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'hp-models-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const script = join(directory, 'models.mjs');
  const marker = join(directory, 'first');
  writeFileSync(script, `import fs from 'node:fs';const p=${JSON.stringify(marker)};if(!fs.existsSync(p)){fs.writeFileSync(p,'1');process.exit(0)}console.log('provider/model');`);
  const result = await listHarnessModels({ modelsCommand: process.execPath, modelsArgs: [script], env: {} });
  assert.deepEqual(result.models, ['provider/model']);
});
