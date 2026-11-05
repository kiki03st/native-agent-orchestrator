import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { sanitizedEnv } from '../run.mjs';
import { splitByMall } from '../lib/fixture.mjs';
import { aggregate, decide } from '../lib/gate.mjs';
import { parseJunit } from '../lib/junit.mjs';
import { evaluateBehavior, overlapMs, streamSummary, transcriptMetrics } from '../lib/metrics.mjs';

test('parseJunit handles self-closing, failed, errored and skipped cases', () => {
  const results = parseJunit(`<testsuite>
    <testcase classname="a" name="ok"/>
    <testcase classname="a" name="bad"><failure>x</failure></testcase>
    <testcase classname="a" name="err"><error>x</error></testcase>
    <testcase classname="a" name="skip"><skipped/></testcase>
    <testcase classname="a" name="dup"></testcase>
    <testcase classname="a" name="dup"><failure/></testcase>
  </testsuite>`);
  assert.deepEqual([...results], [['a::ok', true], ['a::bad', false], ['a::err', false], ['a::dup', false]]);
});

test('splitByMall gives each mall its tests and only naver the login import', () => {
  const parts = splitByMall("import a from 'a';\nimport { MallLoginRequired } from 'n';\n\ntest('st11.normalize x', () => {});\ntest('naver.normalize y', () => {});\ntest('st11.normalize z', () => {});\n");
  assert.deepEqual(Object.keys(parts), ['st11', 'naver']);
  assert.ok(!parts.st11.includes('MallLoginRequired') && parts.st11.includes('st11.normalize z'));
  assert.ok(parts.naver.includes('MallLoginRequired') && !parts.naver.includes('st11'));
  assert.throws(() => splitByMall("x\ntest('other', () => {});"));
});

test('overlapMs counts only time when workers really overlap', () => {
  assert.equal(overlapMs([[0, 10], [20, 30]]), 0);
  assert.equal(overlapMs([[0, 10], [5, 15]]), 5);
  assert.equal(overlapMs([[0, 100], [10, 20], [30, 40]]), 20);
});

test('transcriptMetrics dedupes usage by message id and separates main from subagents', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nao-metrics-'));
  const assistant = (id, model, content, timestamp) => JSON.stringify({ type: 'assistant', timestamp, message: { id, model, content, usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } } });
  fs.writeFileSync(path.join(root, 's.jsonl'), [
    assistant('m1', 'claude-opus-5-5', [{ type: 'tool_use', name: 'Agent', input: {} }]),
    assistant('m1', 'claude-opus-5-5', [{ type: 'tool_use', name: 'Bash', input: { command: 'node cli.cjs show' } }]),
    assistant('m2', '<synthetic>', []),
    JSON.stringify({ attachment: { content: '[Native orchestration policy] x' } }),
    'not json',
  ].join('\n'));
  fs.mkdirSync(path.join(root, 's', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(root, 's', 'subagents', 'a.jsonl'), assistant('w1', 'claude-haiku-5-5', [], '2026-01-01T00:00:00Z') + '\n' + assistant('w2', 'claude-haiku-5-5', [], '2026-01-01T00:00:10Z'));
  fs.writeFileSync(path.join(root, 's', 'subagents', 'b.jsonl'), assistant('w3', 'claude-opus-5-5', [{ type: 'tool_use', name: 'Bash', input: { command: 'gh repo view' } }], '2026-01-01T00:00:05Z') + '\n' + assistant('w4', 'claude-opus-5-5', [], '2026-01-01T00:00:15Z'));
  const metrics = transcriptMetrics(path.join(root, 's.jsonl'));
  assert.equal(metrics.main.turns, 1);
  assert.equal(metrics.main.input_tokens, 1);
  assert.equal(metrics.agentCalls, 1);
  assert.equal(metrics.orchestratorCliCalls, 1);
  assert.equal(metrics.policyInjections, 1);
  assert.equal(metrics.subagents.turns, 4);
  assert.equal(metrics.cheapSubagentTurnShare, 0.5);
  assert.equal(metrics.parallelOverlapMs, 5000);
  assert.equal(metrics.leakSuspects, 1);
});

test('streamSummary marks a run with no result as an error', () => {
  assert.equal(streamSummary('{"type":"system","subtype":"init"}\n').isError, true);
  const done = streamSummary('{"type":"result","total_cost_usd":1.5,"num_turns":2,"is_error":false,"subtype":"success"}');
  assert.deepEqual([done.costUsd, done.isError], [1.5, false]);
});

test('streamSummary adds turns across background wake-ups and keeps the cumulative cost', () => {
  const stretch = (turns) => JSON.stringify({ type: 'result', total_cost_usd: 6, num_turns: turns, is_error: false, subtype: 'success' });
  const done = streamSummary(`${stretch(31)}\n${stretch(3)}`);
  assert.deepEqual([done.costUsd, done.turns], [6, 34]);
});

test('a run stopped by the usage limit is flagged and left out of aggregates', () => {
  const stopped = streamSummary(JSON.stringify({ type: 'result', is_error: true, subtype: 'success', result: "You've hit your 5-hour limit · resets 2am", total_cost_usd: 1 }));
  assert.equal(stopped.limitHit, true);
  assert.equal(streamSummary(JSON.stringify({ type: 'result', is_error: true, subtype: 'error_max_budget_usd', result: 'budget' })).limitHit, false);
  const table = aggregate([{ condition: 'sdd', case: 'g1', stream: stopped, score: { hidden: { pass: 0, total: 1 } } }]);
  assert.equal(table.sdd, undefined);
});

test('leakSuspects flags gh and aside commands, not paths named aside', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nao-leak-'));
  const bash = (id, command) => JSON.stringify({ type: 'assistant', message: { id, model: 'm', content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
  fs.writeFileSync(path.join(root, 's.jsonl'), [
    bash('1', 'cat src/aside/malls/index.ts'), bash('2', 'cd x && gh repo view'), bash('3', 'aside exec "open"'), bash('4', 'git clone https://github.com/a/b'),
  ].join('\n'));
  assert.equal(transcriptMetrics(path.join(root, 's.jsonl')).leakSuspects, 3);
});

test('evaluateBehavior fails a rule whose metric is missing', () => {
  const [present, absent] = evaluateBehavior([
    { id: 'a', metric: 'metrics.agentCalls', op: 'eq', value: 0 },
    { id: 'b', metric: 'metrics.none', op: 'gte', value: 0 },
  ], { metrics: { agentCalls: 0 } });
  assert.equal(present.pass, true);
  assert.equal(absent.pass, false);
});

test('sanitizedEnv strips credentials but keeps Claude auth', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nao-env-'));
  fs.writeFileSync(path.join(dir, 'gh.exe'), '');
  const env = sanitizedEnv({ PATH: `${dir}${path.delimiter}C:\\safe`, GH_TOKEN: 'x', OPENAI_API_KEY: 'x', AWS_SECRET: 'x', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't', KEEP: '1' });
  assert.equal(env.PATH, 'C:\\safe');
  assert.deepEqual([env.GH_TOKEN, env.OPENAI_API_KEY, env.AWS_SECRET], [undefined, undefined, undefined]);
  assert.deepEqual([env.ANTHROPIC_API_KEY, env.CLAUDE_CODE_OAUTH_TOKEN, env.KEEP], ['k', 't', '1']);
});

const GATE = { baseline: 'sdd', minReps: 3, qualityTolerance: 0, maxCaseCostRatio: 1.1, maxTotalCostRatio: 0.8, behaviorCases: ['g1'], minBehaviorRate: 0.66 };
const runs = (condition, id, { hidden = 1, cost = 1, trap = null, behavior = true, n = 3 }) => Array.from({ length: n }, () => ({
  condition, case: id, stream: { costUsd: cost, durationMs: 1000, isError: false },
  score: { hidden: { pass: hidden * 10, total: 10 }, regression: { pass: 5, total: 5 }, trapCaught: trap }, metrics: { agentCalls: 0 }, behavior: [{ pass: behavior }],
}));
const table = (challenger) => aggregate([...runs('sdd', 'g1', { cost: 2 }), ...runs('sdd', 'g3', { cost: 2, trap: true }), ...runs('next', 'g1', challenger.g1), ...runs('next', 'g3', challenger.g3)]);

test('gate passes a cheaper challenger with equal quality', () => {
  const verdict = decide(table({ g1: { cost: 1 }, g3: { cost: 2, trap: true } }), 'next', GATE, ['g1', 'g3']);
  assert.equal(verdict.verdict, 'REPLACE_CANDIDATE');
});

test('gate never trades quality or the trap for cost', () => {
  assert.equal(decide(table({ g1: { cost: 0.1, hidden: 0.9 }, g3: { cost: 0.1, trap: true } }), 'next', GATE, ['g1', 'g3']).verdict, 'NOT_YET');
  assert.equal(decide(table({ g1: { cost: 0.1 }, g3: { cost: 0.1, trap: false } }), 'next', GATE, ['g1', 'g3']).verdict, 'NOT_YET');
});

test('gate rejects total savings when one case costs more, and failed behavior', () => {
  assert.equal(decide(table({ g1: { cost: 2.5 }, g3: { cost: 0.5, trap: true } }), 'next', GATE, ['g1', 'g3']).verdict, 'NOT_YET');
  assert.equal(decide(table({ g1: { cost: 1, behavior: false }, g3: { cost: 1, trap: true } }), 'next', GATE, ['g1', 'g3']).verdict, 'NOT_YET');
});

test('gate reports INCONCLUSIVE when runs are missing', () => {
  const verdict = decide(table({ g1: { cost: 1, n: 2 }, g3: { cost: 1, trap: true } }), 'next', GATE, ['g1', 'g3']);
  assert.equal(verdict.verdict, 'INCONCLUSIVE');
});
