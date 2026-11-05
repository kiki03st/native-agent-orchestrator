import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { caseDir, caseEnv, copyTree, linkDeps, readJson, removeTree, sh } from './common.mjs';
import { parseJunit } from './junit.mjs';

function typecheck(testCase, dir, env) {
  if (!testCase.typecheck) return null;
  return spawnSync(testCase.typecheck, { cwd: dir, env, shell: true, encoding: 'utf8', timeout: 300000 }).status === 0;
}

/** Runs the pristine hidden tests against a copy, so changes the agent made to tests cannot affect its score. */
export function scoreTree(testCase, tree, { raw = false } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `nao-score-${testCase.id}-`));
  try {
    copyTree(tree, work);
    const testsDir = path.join(work, testCase.testsDir);
    fs.rmSync(testsDir, { recursive: true, force: true });
    copyTree(path.join(caseDir(testCase.id), 'hidden-tests'), testsDir);
    linkDeps(testCase, work);
    const env = caseEnv(testCase);
    const junit = path.join(work, 'nao-junit.xml');
    const run = spawnSync(testCase.test.replace('{junit}', `"${junit}"`), { cwd: work, env, shell: true, encoding: 'utf8', timeout: 600000, maxBuffer: 1 << 28 });
    const tests = fs.existsSync(junit) ? parseJunit(fs.readFileSync(junit, 'utf8')) : new Map();
    const result = { tests, typecheck: typecheck(testCase, work, env), exit: run.status };
    return raw ? result : summarize(testCase, result);
  } finally { removeTree(work); }
}

const tally = (ids, tests) => ({ pass: ids.filter((id) => tests.get(id) === true).length, total: ids.length, failed: ids.filter((id) => tests.get(id) !== true) });

export function summarize(testCase, { tests, typecheck: typecheckResult }) {
  const meta = readJson(path.join(caseDir(testCase.id), 'meta.json'));
  const groups = {};
  for (const [name, pattern] of Object.entries(testCase.groups || {})) {
    const regex = new RegExp(pattern);
    groups[name] = tally(meta.hidden.filter((id) => regex.test(id)), tests);
  }
  const trapIds = testCase.trap ? meta.hidden.filter((id) => new RegExp(testCase.trap).test(id)) : null;
  return {
    hidden: tally(meta.hidden, tests),
    regression: tally(meta.regression, tests),
    groups,
    trapCaught: trapIds ? trapIds.length > 0 && trapIds.every((id) => tests.get(id) === true) : null,
    typecheck: typecheckResult,
  };
}

export function diffStat(workdir, env) {
  const index = path.join(os.tmpdir(), `nao-index-${process.pid}-${Date.now()}`);
  const withIndex = { ...env, GIT_INDEX_FILE: index };
  try {
    const first = sh('git rev-list --max-parents=0 HEAD', { cwd: workdir, env }).stdout.trim().split(/\r?\n/).at(-1);
    sh('git add -A', { cwd: workdir, env: withIndex });
    const rows = sh(`git diff --cached --numstat ${first}`, { cwd: workdir, env: withIndex }).stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => line.split('\t'));
    const source = rows.filter(([, , file]) => !/(^|\/)tests?\//.test(file) && file !== 'docs/plan.md');
    const sum = (list, column) => list.reduce((total, row) => total + (Number(row[column]) || 0), 0);
    return { files: rows.length, sourceFiles: source.length, sourceAdded: sum(source, 0), sourceDeleted: sum(source, 1), worktrees: sh('git worktree list', { cwd: workdir, env }).stdout.trim().split(/\r?\n/).length };
  } finally { fs.rmSync(index, { force: true }); }
}
