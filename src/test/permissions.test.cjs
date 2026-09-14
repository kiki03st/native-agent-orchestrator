const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const e = require('../engine.cjs');

test('POSIX ledger directory and SQLite files are private even with a permissive umask', { skip: process.platform === 'win32' }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-permissions-'));
  const previous = process.umask(0o022);
  let db;
  t.after(() => { db?.close(); process.umask(previous); fs.rmSync(dir, { recursive: true, force: true }); });
  const data = path.join(dir, 'app-data'), filename = path.join(data, 'state.sqlite');
  db = e.openDb(filename);
  assert.equal(fs.statSync(data).mode & 0o777, 0o700);
  for (const suffix of ['', '-wal', '-shm']) {
    assert.equal(fs.statSync(filename + suffix).mode & 0o077, 0, 'No group/other access to ' + suffix);
  }
  assert.equal(process.umask(), 0o022, 'Application must restore the caller umask');
});
