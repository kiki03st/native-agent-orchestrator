import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CASE_IDS, HOME, REPO, caseDir, caseEnv, copyTree, linkDeps, loadCase, removeTree, sh, writeJson } from './common.mjs';
import { scoreTree } from './score.mjs';

const NAO_PINNED = '485120e546db81b109d93cc322cae8d37f5acea3';
const SUPERPOWERS = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'claude-plugins-official', 'superpowers', '7.0.0');

/** Git settings for fixtures and agents: no user credential helper, no global hooks. */
export function gitEnv(base = process.env) {
  const config = path.join(HOME, 'gitconfig');
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(config, '[user]\n\tname = eval\n\temail = eval@example.invalid\n[core]\n\tautocrlf = false\n[init]\n\tdefaultBranch = main\n');
  return { ...base, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
}

function source(testCase) {
  const dir = path.join(HOME, 'sources', testCase.source.repo.split('/')[1]);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    sh(`gh repo clone ${testCase.source.repo} "${dir}" -- -q`);
  }
  return dir;
}

function exportTree(repo, commit, subdir, dest) {
  fs.mkdirSync(dest, { recursive: true });
  // Relative name and cwd: GNU tar reads "C:\..." as a remote host.
  const archive = `.nao-archive-${process.pid}.tar`;
  sh(`git -C "${repo}" archive --format=tar -o "${path.join(dest, archive)}" ${subdir ? `${commit}:${subdir}` : commit}`);
  sh(`tar -xf ${archive}`, { cwd: dest });
  fs.rmSync(path.join(dest, archive));
}

function strip(testCase, dir) {
  for (const item of testCase.remove || []) fs.rmSync(path.join(dir, item), { recursive: true, force: true });
  for (const [file, text] of Object.entries(testCase.writeFiles || {})) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
}

/** One failing import must only cost that mall's tests, so the shared test file becomes one file per mall. */
export function splitByMall(text) {
  const [preamble, ...blocks] = text.replace(/\r\n/g, '\n').split(/\n(?=test\()/);
  const groups = {};
  for (const block of blocks) {
    const mall = /^test\('(\w+)\./.exec(block)?.[1];
    if (!mall) throw new Error('Unexpected test block: ' + block.slice(0, 60));
    (groups[mall] ||= []).push(block);
  }
  return Object.fromEntries(Object.entries(groups).map(([mall, parts]) => [mall,
    (mall === 'naver' ? preamble : preamble.replace(/^import \{ MallLoginRequired \}.*\n/m, '')) + '\n' + parts.join('\n') + '\n']));
}

/** Plants review-case defects in one tree. A find that no longer matches is an error, not a silent no-op. */
export function applySeeds(seeds, dir) {
  for (const { file, find, replace } of seeds) {
    const target = path.join(dir, file);
    const text = fs.readFileSync(target, 'utf8');
    if (!text.includes(find)) throw new Error(`Seed target not found in ${file}: ${find}`);
    fs.writeFileSync(target, text.replace(find, () => replace));
  }
}

function hiddenTests(testCase, solution, dest) {
  copyTree(path.join(solution, testCase.testsDir), dest);
  for (const file of testCase.extraHiddenTests || []) fs.copyFileSync(path.join(path.dirname(testCase.planFile), file), path.join(dest, file));
  applySeeds(testCase.testPatches || [], dest); // Relaxes solution tests that demand more than the plan states.
  if (testCase.splitTest) {
    const file = path.join(dest, testCase.splitTest);
    for (const [mall, body] of Object.entries(splitByMall(fs.readFileSync(file, 'utf8')))) fs.writeFileSync(path.join(dest, `hidden-${mall}.test.ts`), body);
    fs.rmSync(file);
  }
}

function installDeps(testCase, base) {
  const dir = caseDir(testCase.id);
  if (testCase.runtime === 'node') {
    const deps = path.join(dir, 'deps');
    fs.mkdirSync(deps, { recursive: true });
    for (const file of ['package.json', 'package-lock.json', '.npmrc']) if (fs.existsSync(path.join(base, file))) fs.copyFileSync(path.join(base, file), path.join(deps, file));
    if (!fs.existsSync(path.join(deps, 'node_modules'))) sh('npm ci --silent --no-audit --no-fund', { cwd: deps });
  } else {
    const venv = path.join(dir, 'venv');
    if (!fs.existsSync(venv)) {
      sh(`python -m venv "${venv}"`);
      sh(`"${path.join(venv, 'Scripts', 'python.exe')}" -m pip install -q ${testCase.pipDeps.map((d) => `"${d}"`).join(' ')}`);
    }
  }
}

export function pluginPaths() {
  return { naoCurrent: path.join(HOME, 'plugins', 'nao-current'), superpowers: path.join(HOME, 'plugins', 'superpowers-7.0.0') };
}

/** Freezes both plugins, so later edits to this repo or a superpowers update cannot change the baseline. */
export function buildPlugins() {
  const { naoCurrent, superpowers } = pluginPaths();
  const built = (dir) => fs.existsSync(path.join(dir, '.claude-plugin'));
  if (!built(naoCurrent)) exportTree(REPO, NAO_PINNED, 'claude-plugins/native-agent-orchestrator', naoCurrent);
  if (!built(superpowers)) copyTree(SUPERPOWERS, superpowers, ['.git', 'node_modules', '.in_use']);
  return { naoCurrent, superpowers };
}

export function buildCase(id) {
  const testCase = loadCase(id);
  const dir = caseDir(id);
  for (const child of ['base', 'solution', 'hidden-tests']) removeTree(path.join(dir, child));
  const repo = source(testCase);
  const base = path.join(dir, 'base'), solution = path.join(dir, 'solution'), hidden = path.join(dir, 'hidden-tests');
  exportTree(repo, testCase.source.base, testCase.source.subdir, base);
  exportTree(repo, testCase.source.solution, testCase.source.subdir, solution);
  strip(testCase, base);
  strip(testCase, solution);
  applySeeds(testCase.seeds || [], base);
  for (const item of testCase.inputsFromSolution || []) fs.cpSync(path.join(solution, item), path.join(base, item), { recursive: true });
  fs.mkdirSync(path.join(base, 'docs'), { recursive: true });
  fs.copyFileSync(testCase.planFile, path.join(base, 'docs', 'plan.md'));
  hiddenTests(testCase, solution, hidden);
  installDeps(testCase, base);

  // The expected ids come from running the same tests on both trees, never from a hand-kept list.
  const onBase = scoreTree(testCase, base, { raw: true });
  const onSolution = scoreTree(testCase, solution, { raw: true });
  const passed = (map) => [...map].filter(([, ok]) => ok).map(([key]) => key);
  const solutionPass = new Set(passed(onSolution.tests));
  const basePass = new Set(passed(onBase.tests));
  const meta = {
    case: id, source: testCase.source,
    hidden: [...solutionPass].filter((key) => !basePass.has(key)).sort(),
    regression: [...solutionPass].filter((key) => basePass.has(key)).sort(),
    failingOnSolution: [...onSolution.tests].filter(([, ok]) => !ok).map(([key]) => key).sort(),
    typecheck: { base: onBase.typecheck, solution: onSolution.typecheck },
  };
  if (!meta.hidden.length) throw new Error(`${id}: no test separates the base from the solution`);
  writeJson(path.join(dir, 'meta.json'), meta);
  return meta;
}

export function buildAll(ids = CASE_IDS) {
  const plugins = buildPlugins();
  return { plugins, metas: ids.map(buildCase) };
}

/** Creates a fresh one-commit repository with no remote and no project history. */
export function makeWorkdir(id, dest) {
  const testCase = loadCase(id);
  removeTree(dest);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  copyTree(path.join(caseDir(id), 'base'), dest);
  const env = gitEnv(caseEnv(testCase));
  sh('git init -q', { cwd: dest, env });
  sh('git add -A', { cwd: dest, env });
  sh('git commit -q -m "fixture snapshot"', { cwd: dest, env });
  linkDeps(testCase, dest);
  return dest;
}
