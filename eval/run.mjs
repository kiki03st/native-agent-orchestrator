// One run: fresh fixture -> isolated Claude Code session -> hidden-test score -> result.json.
// Usage: node eval/run.mjs --case g1 --condition sdd --rep 1 [--plugin-dir DIR] [--budget 25] [--timeout-min 90] [--dry-run]
//        node eval/run.mjs --smoke --condition sdd
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { EVAL, HOME, caseEnv, loadCase, readJson, removeTree, sh, writeJson } from './lib/common.mjs';
import { gitEnv, makeWorkdir, pluginPaths } from './lib/fixture.mjs';
import { evaluateBehavior, findTranscript, streamSummary, transcriptMetrics } from './lib/metrics.mjs';
import { diffStat, scoreTree } from './lib/score.mjs';

export const COMMON_PROMPT = `docs/plan.md의 작업을 끝까지 수행하세요.
- 질문하지 말고 스스로 판단해 끝까지 진행하세요.
- 현재 디렉터리의 현재 브랜치에서 작업하세요. git worktree를 만들거나 브랜치를 옮기지 마세요.
- 네트워크가 필요한 명령과 원격 저장소 작업은 하지 마세요.
- 커밋 여부는 자유입니다. 작업 트리의 최종 상태로 채점합니다.`;

/** Anything that could reach the original repository or unrelated accounts is taken out of the agent's environment. */
export function sanitizedEnv(base) {
  const allowed = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)$/;
  const env = Object.fromEntries(Object.entries(base).filter(([key]) => allowed.test(key) || !/(TOKEN|SECRET|PASSWORD|API_KEY|_KEY)$/i.test(key)));
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');
  env[pathKey] = env[pathKey].split(path.delimiter).filter((dir) => !['gh.exe', 'aside.exe', 'aside'].some((tool) => { try { return fs.existsSync(path.join(dir, tool)); } catch { return false; } })).join(path.delimiter);
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  return env;
}

export function claudeArgs({ condition, plugins, sessionId, budget, model, effort }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--session-id', sessionId, '--model', model,
    '--setting-sources', 'project', '--strict-mcp-config', '--permission-mode', 'bypassPermissions', '--max-budget-usd', String(budget)];
  if (effort) args.push('--effort', effort);
  for (const dir of plugins) args.push('--plugin-dir', dir);
  if (condition.disallowedTools.length) args.push('--disallowedTools', condition.disallowedTools.join(','));
  return args;
}

function resolvePlugins(condition, pluginDir) {
  const known = { ...pluginPaths(), pluginDir };
  return condition.plugins.map((item) => {
    const resolved = known[item.slice(1, -1)];
    if (!resolved || !fs.existsSync(resolved)) throw new Error(`Plugin not available: ${item}. Run build.mjs or pass --plugin-dir.`);
    return resolved;
  });
}

function runClaude({ args, prompt, cwd, env, eventsFile, stderrFile, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn('claude', args, { cwd, env, stdio: ['pipe', fs.openSync(eventsFile, 'w'), fs.openSync(stderrFile, 'w')] });
    const timer = setTimeout(() => { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']); resolve({ timedOut: true }); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, timedOut: false }); });
    child.on('error', (error) => { clearTimeout(timer); resolve({ error: error.message, timedOut: false }); });
    child.stdin.end(prompt);
  });
}

export function finalize({ testCase, conditionName, rep, sessionId, workdir, stream, exitInfo, startedAt, env }) {
  const transcript = findTranscript(sessionId);
  const metrics = transcript ? transcriptMetrics(transcript) : null;
  const score = scoreTree(testCase, workdir);
  const record = {
    case: testCase.id, condition: conditionName, rep, sessionId, startedAt, exit: exitInfo, stream, metrics, score,
    hiddenFailed: score.hidden.total - score.hidden.pass,
    regressionFailed: score.regression.total - score.regression.pass,
    diff: diffStat(workdir, env),
  };
  record.behavior = metrics ? evaluateBehavior(testCase.behavior, record) : [];
  return record;
}

async function smoke(values, conditions) {
  const condition = conditions[values.condition];
  const dir = path.join(HOME, 'smoke', values.condition);
  removeTree(dir);
  fs.mkdirSync(dir, { recursive: true });
  const env = sanitizedEnv(gitEnv());
  sh('git init -q', { cwd: dir, env });
  const sessionId = randomUUID();
  const plugins = resolvePlugins(condition, values['plugin-dir']);
  const args = claudeArgs({ condition, plugins, sessionId, budget: 0.5, model: 'haiku' });
  const eventsFile = path.join(dir, 'events.jsonl'), stderrFile = path.join(dir, 'stderr.log');
  const exit = await runClaude({ args, prompt: 'Reply with exactly: OK. Do not use any tools.', cwd: dir, env, eventsFile, stderrFile, timeoutMs: 180000 });
  const stream = streamSummary(fs.readFileSync(eventsFile, 'utf8'));
  const transcript = findTranscript(sessionId);
  const metrics = transcript ? transcriptMetrics(transcript) : null;
  console.log(JSON.stringify({
    condition: values.condition, exit, costUsd: stream.costUsd, isError: stream.isError, plugins: stream.plugins, mcpServers: stream.mcpServers,
    skillCount: stream.skills.length, sddSkill: stream.skills.some((skill) => /subagent-driven-development/.test(skill)), transcriptFound: !!transcript,
    mainTurns: metrics?.main.turns, policyInjections: metrics?.policyInjections,
    stderr: fs.readFileSync(stderrFile, 'utf8').slice(0, 300),
  }));
}

async function main() {
  const { values } = parseArgs({ options: {
    case: { type: 'string' }, condition: { type: 'string' }, rep: { type: 'string', default: '1' }, 'plugin-dir': { type: 'string' },
    budget: { type: 'string', default: '25' }, 'timeout-min': { type: 'string', default: '90' }, model: { type: 'string', default: 'opus' }, effort: { type: 'string', default: 'high' },
    'dry-run': { type: 'boolean', default: false }, smoke: { type: 'boolean', default: false },
  } });
  const conditions = readJson(path.join(EVAL, 'conditions.json'));
  const condition = conditions[values.condition];
  if (!condition) throw new Error(`Unknown condition. Use one of: ${Object.keys(conditions).join(', ')}`);
  if (values.smoke) return smoke(values, conditions);

  const testCase = loadCase(values.case);
  const label = `${values.condition}/${testCase.id}/r${values.rep}`;
  const output = path.join(HOME, 'results', label);
  const workdir = path.join(HOME, 'work', label);
  const plugins = resolvePlugins(condition, values['plugin-dir']);
  const sessionId = randomUUID();
  const args = claudeArgs({ condition, plugins, sessionId, budget: Number(values.budget), model: values.model, effort: values.effort });
  const prompt = condition.prefix + COMMON_PROMPT;
  if (values['dry-run']) { console.log(JSON.stringify({ label, workdir, args, prompt }, null, 2)); return; }

  if (fs.existsSync(path.join(output, 'result.json'))) throw new Error(`${label} already has a result. Delete it first to rerun.`);
  fs.mkdirSync(output, { recursive: true });
  makeWorkdir(testCase.id, workdir);
  const env = sanitizedEnv(gitEnv(caseEnv(testCase)));
  env.ORCHESTRATOR_STATE_DIR = path.join(output, 'orchestrator-state');
  const startedAt = new Date().toISOString();
  const eventsFile = path.join(output, 'events.jsonl');
  const exitInfo = await runClaude({ args, prompt, cwd: workdir, env, eventsFile, stderrFile: path.join(output, 'stderr.log'), timeoutMs: Number(values['timeout-min']) * 60000 });
  const stream = streamSummary(fs.readFileSync(eventsFile, 'utf8'));
  if (stream.limitHit) {
    writeJson(path.join(output, 'invalid.json'), { case: testCase.id, condition: values.condition, rep: Number(values.rep), sessionId, startedAt, reason: 'usage limit', stream });
    throw new Error(`${label}: usage limit reached, run not scored. Rerun after the reset.`);
  }
  const record = finalize({ testCase, conditionName: values.condition, rep: Number(values.rep), sessionId, workdir, stream, exitInfo, startedAt, env });
  writeJson(path.join(output, 'result.json'), record);
  console.log(`${label}: hidden ${record.score.hidden.pass}/${record.score.hidden.total}, regression ${record.score.regression.pass}/${record.score.regression.total}, cost ${stream.costUsd}, ${stream.subtype}`);
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
