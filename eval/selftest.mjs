// Proves the scorer before any model is paid for: wrong fixes must fail, different correct fixes must pass.
// Usage: node eval/selftest.mjs [g1 g2 g3]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CASE_IDS, caseDir, caseEnv, copyTree, loadCase, removeTree } from './lib/common.mjs';
import { applySeeds, gitEnv, makeWorkdir } from './lib/fixture.mjs';
import { diffStat, scoreTree } from './lib/score.mjs';

function rewrite(file, change) {
  const before = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const after = change(before);
  if (after === before) throw new Error(`Variant did not change ${file}`);
  fs.writeFileSync(file, after);
}

const full = (score) => score.hidden.pass === score.hidden.total && score.regression.pass === score.regression.total;
const SEARCH = 'src/ai/kb/search.py';
const MALLS = 'src/aside/malls';
const CYCLE = 'src/bot/cycle.ts';
const RUN = 'src/backtest/run.ts';
const fromBase = (id, file) => (dir) => fs.copyFileSync(path.join(caseDir(id), 'base', file), path.join(dir, file));

const VARIANTS = {
  g1: [
    { name: 'base', tree: 'base', expect: (s) => s.hidden.pass === 0 && s.regression.pass === s.regression.total },
    { name: 'golden', tree: 'solution', expect: full },
    { name: 'alt: dict + RLock', tree: 'base', edit: (dir) => rewrite(path.join(dir, SEARCH), (text) => text
      .replace('@lru_cache(maxsize=8)\ndef load_cases(cases_dir: Path = CASES_DIR) -> tuple[Case, ...]:',
        'def _parse_cases(cases_dir: Path) -> tuple[Case, ...]:')
      + '\n\nimport threading\n_CACHE: dict = {}\n_RLOCK = threading.RLock()\n\n\ndef load_cases(cases_dir: Path = CASES_DIR) -> tuple[Case, ...]:\n    key = Path(cases_dir)\n    with _RLOCK:\n        if key not in _CACHE:\n            _CACHE[key] = _parse_cases(key)\n        return _CACHE[key]\n\n\nload_cases.cache_clear = _CACHE.clear\n'), expect: full },
    { name: 'mutant: lock does nothing', tree: 'solution', edit: (dir) => rewrite(path.join(dir, SEARCH), (text) => text.replace('with _LOAD_LOCK:', 'if True:')), expect: (s) => s.hidden.failed.length === 1 && /concurrent/.test(s.hidden.failed[0]) },
  ],
  g2: [
    { name: 'base', tree: 'base', expect: (s) => s.hidden.pass === 0 && s.regression.pass === s.regression.total },
    { name: 'golden', tree: 'solution', expect: (s) => full(s) && s.typecheck === true },
    { name: 'alt: normalize only, code stubbed', tree: 'solution', edit: (dir) => {
      for (const mall of ['gmarket', 'st11', 'oliveyoung', 'naver']) rewrite(path.join(dir, MALLS, `${mall}.ts`), (text) => text
        .replace(/searchCode\(query, limit\) \{[\s\S]*?\n(\s*normalize\()/, "searchCode() {\n    throw new Error('not implemented');\n  },\n\n$1")
        .replace(/priceCheckCode\(url\) \{[\s\S]*?\n\};/, "priceCheckCode() {\n    throw new Error('not implemented');\n  },\n};"));
    }, expect: full },
    { name: 'mutant: naver missing', tree: 'solution', edit: (dir) => {
      fs.rmSync(path.join(dir, MALLS, 'naver.ts'));
      rewrite(path.join(dir, MALLS, 'index.ts'), (text) => text.replace("import { naver } from './naver.ts';\n", '').replace('st11, naver, oliveyoung }', 'st11, oliveyoung } as Record<MallId, MallRecipe>'));
    }, expect: (s) => s.groups.naver.pass === 0 && ['gmarket', 'st11', 'oliveyoung'].every((mall) => s.groups[mall].failed.length === 0) },
  ],
  g3: [
    { name: 'base', tree: 'base', expect: (s) => s.hidden.pass === 0 && s.trapCaught === false && s.regression.pass === s.regression.total },
    { name: 'golden', tree: 'solution', expect: (s) => full(s) && s.trapCaught === true && s.typecheck === true },
    { name: 'alt: different wiring', tree: 'solution', edit: (dir) => rewrite(path.join(dir, CYCLE), (text) => text.replace(/const highLow =[\s\S]*?: undefined;/, 'const highLow = { highs: aligned.highs!, lows: aligned.lows! };')), expect: (s) => full(s) && s.trapCaught === true },
    { name: 'mutant: bot not wired (T31 trap)', tree: 'solution', edit: (dir) => fs.copyFileSync(path.join(caseDir('g3'), 'base', CYCLE), path.join(dir, CYCLE)), expect: (s) => s.trapCaught === false && s.hidden.failed.length === 1 && s.typecheck === true },
    { name: 'mutant: backtest not wired', tree: 'solution', edit: (dir) => fs.copyFileSync(path.join(caseDir('g3'), 'base', RUN), path.join(dir, RUN)), expect: (s) => s.trapCaught === true && s.hidden.failed.length === 1 && /backtest-run/.test(s.hidden.failed[0]) },
  ],
  g4: [
    { name: 'base', tree: 'base', expect: (s) => s.hidden.pass === 0 && s.regression.pass === s.regression.total },
    { name: 'golden', tree: 'solution', expect: (s) => full(s) && s.typecheck === true && Object.values(s.groups).every((group) => group.total > 0) },
    { name: 'mutant: cooldown ignored', tree: 'solution', edit: (dir) => rewrite(path.join(dir, MALLS, 'index.ts'), (text) => text.replace('if (until && until > Date.now())', 'if (false && until)')), expect: (s) => s.groups.blocked.failed.length === 1 && s.hidden.failed.length === 1 },
    { name: 'mutant: stale planned kept', tree: 'solution', edit: (dir) => rewrite(path.join(dir, 'src/history/purchases.ts'), (text) => text.replace(/delete from purchases/g, 'select 1 from purchases')), expect: (s) => s.groups.history.failed.length >= 1 && s.groups.cart.failed.length === 0 },
  ],
  g5: [
    { name: 'base: seven defects, visible tests green', tree: 'base', expect: (s) => s.hidden.total === 7 && s.hidden.pass === 0 && s.regression.pass === s.regression.total && s.typecheck === true },
    { name: 'golden', tree: 'solution', expect: (s) => full(s) && s.typecheck === true },
    { name: 'mutant: only D4 left', tree: 'solution', edit: (dir) => applySeeds(loadCase('g5').seeds.filter((seed) => seed.id === 'D4'), dir), expect: (s) => s.hidden.failed.length === 1 && /D4 /.test(s.hidden.failed[0]) },
    { name: 'mutant: only D7 left', tree: 'solution', edit: (dir) => applySeeds(loadCase('g5').seeds.filter((seed) => seed.id === 'D7'), dir), expect: (s) => s.hidden.failed.length === 1 && /D7 /.test(s.hidden.failed[0]) },
  ],
};

function runVariant(testCase, variant) {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), `nao-variant-${testCase.id}-`));
  try {
    copyTree(path.join(caseDir(testCase.id), variant.tree), tree);
    variant.edit?.(tree);
    return scoreTree(testCase, tree);
  } finally { removeTree(tree); }
}

function cleanWorkdir(id) {
  const dir = path.join(os.tmpdir(), `nao-selftest-work-${id}-${process.pid}`);
  const testCase = loadCase(id);
  try {
    makeWorkdir(id, dir);
    const stat = diffStat(dir, gitEnv(caseEnv(testCase)));
    return stat.files === 0 ? null : `fresh workdir should show no changes, got ${stat.files} (is node_modules ignored?)`;
  } finally { removeTree(dir); }
}

let failures = 0;
for (const id of process.argv.length > 2 ? process.argv.slice(2) : CASE_IDS) {
  const testCase = loadCase(id);
  const dirty = cleanWorkdir(id);
  console.log(`${dirty ? 'FAIL' : 'ok  '} ${id} workdir clean${dirty ? `: ${dirty}` : ''}`);
  if (dirty) failures++;
  for (const variant of VARIANTS[id]) {
    const score = runVariant(testCase, variant);
    const pass = variant.expect(score);
    if (!pass) failures++;
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${id} ${variant.name}: hidden ${score.hidden.pass}/${score.hidden.total}, regression ${score.regression.pass}/${score.regression.total}, trap ${score.trapCaught}, typecheck ${score.typecheck}`);
    if (!pass) console.log('     hidden failed:', score.hidden.failed.slice(0, 6), 'regression failed:', score.regression.failed.slice(0, 6));
  }
}
console.log(failures ? `${failures} expectation(s) failed` : 'all expectations hold');
process.exitCode = failures ? 1 : 0;
