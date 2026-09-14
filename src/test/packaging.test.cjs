const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const e = require('../engine.cjs');

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator package '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test('two installed copies share a user data ledger outside the plugin cache', t => {
  const dir = temporary(t), data = path.join(dir, 'user data');
  for (const copy of ['codex cache', 'claude cache']) {
    const dest = path.join(dir, copy);
    fs.mkdirSync(dest);
    for (const name of fs.readdirSync(path.join(__dirname, '..'))) {
      if (name.endsWith('.cjs') || name.endsWith('.json'))
        fs.copyFileSync(path.join(__dirname, '..', name), path.join(dest, name));
    }
    const env = { ...process.env, ORCHESTRATOR_STATE_DIR: data };
    delete env.CODEX_ORCH_DB;
    const child = spawnSync(process.execPath, ['-e', "const e=require('./engine.cjs'); const db=e.openDb(); db.close();"], { cwd: dest, env, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.ok(fs.existsSync(path.join(data, 'state.sqlite')), 'ledger must be in user data directory');
    assert.equal(fs.existsSync(path.join(dest, 'state.sqlite')), false, 'cache must remain read-only');
  }
});
test('Claude dispatch uses plugin-qualified names but profile filenames stay local', t => {
  let db;
  t.after(() => db?.close());
  const dir = temporary(t);
  db = e.openDb(path.join(dir, 'test.sqlite'));
  const run = e.createRun(db, { runtime: 'claude', objective: 'Portable plugin', cwd: dir, steps: [{
    id: 'a', task: 'Read a file', model: 'sonnet', reasoning_effort: 'medium', reason: 'Bounded task',
    depends_on: [], read_paths: [], write_paths: [], acceptance: ['Read verified']
  }] }, 'parent');
  const input = e.prepare(db, run.id, 'a');
  assert.equal(input.subagent_type, 'native-agent-orchestrator:orch-sonnet-medium-one');
});
