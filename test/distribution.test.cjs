const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const name = 'native-agent-orchestrator';

for (const scenario of ['codex', 'collaboration', 'claude']) test(`${scenario} relocated distribution preserves memory and two-step dependencies`, t => {
  const runtime = scenario === 'claude' ? 'claude' : 'codex';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable plugin '));
  let db;
  t.after(() => { db?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const original = path.join(repo, runtime === 'codex' ? 'plugins' : 'claude-plugins', name);
  assert.ok(fs.existsSync(path.join(original, 'scripts', 'engine.cjs')), 'build must ship a standalone engine');
  const plugin = path.join(dir, 'plugin copy');
  fs.cpSync(original, plugin, { recursive: true });
  const config = JSON.parse(fs.readFileSync(path.join(plugin, 'hooks/hooks.json'), 'utf8'));
  const env = { ...process.env, PLUGIN_ROOT: plugin, CLAUDE_PLUGIN_ROOT: plugin, CODEX_ORCH_DB: path.join(dir, 'user data', 'state.sqlite') };
  delete env.CLAUDE_ORCH_AGENT_DIR;
  delete env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE;
  function hook(event) {
    const group = config.hooks[event.hook_event_name].find(g => !g.matcher || new RegExp(g.matcher).test(event.tool_name || event.agent_type || ''));
    assert.ok(group, 'distributed matcher must observe the native event');
    const handler = group.hooks[0];
    const options = { env, cwd: dir, input: JSON.stringify({ session_id: 'parent', cwd: dir, ...event }), encoding: 'utf8' };
    const child = handler.args ? spawnSync(handler.command, handler.args.map(x => x.replaceAll('${CLAUDE_PLUGIN_ROOT}', plugin)), options)
      : spawnSync(handler.command, { ...options, shell: true });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  }
  const context = hook({ hook_event_name: 'UserPromptSubmit', prompt: '진행 상황 알려줘' });
  assert.ok(context.hookSpecificOutput.additionalContext.includes(path.join(plugin, 'scripts/cli.cjs').replaceAll('\\', '\\\\')));
  assert.equal(fs.existsSync(path.join(plugin, 'scripts/state.sqlite')), false);
  const e = require(path.join(plugin, 'scripts/engine.cjs'));
  db = e.openDb(env.CODEX_ORCH_DB);
  const first = {
    id: 'a', task: 'Check result', model: runtime === 'codex' ? 'gpt-5.6-sol' : 'sonnet', reasoning_effort: runtime === 'codex' ? 'high' : 'medium',
    reason: 'Review', depends_on: [], read_paths: [], write_paths: [], acceptance: ['Parent verified']
  };
  const run = e.createRun(db, { runtime, ...(scenario === 'collaboration' ? { codex_contract: scenario } : {}), objective: 'Package lifecycle', cwd: dir,
    steps: [first, { ...first, id: 'b', depends_on: ['a'] }] }, 'parent');
  const memory = require(path.join(plugin, 'scripts/memory.cjs'));
  const state = Object.fromEntries(['goals','decisions','constraints','facts','evidence','assumptions','questions','next_actions','detail_references'].map(key => [key, []]));
  state.goals = ['설치본 메모 검증'];
  const saved = memory.write(db, run.id, 'parent', { expected_revision: null, state });
  assert.throws(() => e.prepare(db, run.id, 'b'), /Dependency/);
  for (const step of ['a', 'b']) {
  const input = e.prepare(db, run.id, step);
  const assignment = input.message || input.prompt;
  assert.deepEqual(JSON.parse(assignment.split('\n').at(-1)).context_memory, { path: saved.path });
  assert.ok(!assignment.includes(state.goals[0]), 'only a relevant memory path is injected');
  const tool = scenario === 'collaboration' ? 'collaborationspawn_agent' : runtime === 'codex' ? 'spawn_agent' : 'Agent';
  const call = 'call-' + step, agent = scenario === 'collaboration' ? '/root/' + input.task_name : 'worker-' + step;
  assert.deepEqual(hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_use_id: call, tool_input: input }), {});
  if (runtime === 'claude') {
    hook({ hook_event_name: 'SubagentStart', agent_id: agent, agent_type: input.subagent_type });
    hook({ hook_event_name: 'SubagentStop', agent_id: agent, agent_type: input.subagent_type, effort: { level: 'medium' } });
  } else {
    hook({ hook_event_name: 'PostToolUse', tool_name: tool, tool_use_id: call, tool_input: input,
      tool_response: scenario === 'collaboration' ? { task_name: agent } : { agent_id: agent } });
  }
  assert.equal(e.getRun(db, run.id).steps.find(s => s.id === step).closed, false);
  assert.throws(() => memory.write(db, run.id, 'parent', { expected_revision: saved.revision, state }), /active worker/);
  if (step === 'a') assert.throws(() => e.prepare(db, run.id, 'b'), /Dependency/);
  e.report(db, run.id, step, { agent_id: agent, call_id: call, summary: 'Verified', verified: true, evidence: ['Fixture checked'], changed_files: [],
    execution_complete: true, completion_status: 'completed', completion_evidence: 'Synthetic terminal fixture', model_evidence: 'Synthetic model fixture',
    observed_model: runtime === 'codex' ? 'gpt-5.6-sol' : 'claude-sonnet-5', observed_effort: runtime === 'codex' ? 'high' : 'medium' });
  if (scenario === 'codex') {
    if (step === 'a') assert.throws(() => e.prepare(db, run.id, 'b'), /Dependency/);
    hook({ hook_event_name: 'PostToolUse', tool_name: 'close_agent', tool_input: { target: agent }, tool_response: { previous_status: { completed: 'Done' } } });
  }
  assert.equal(e.getRun(db, run.id).steps.find(s => s.id === step).closed, scenario !== 'collaboration');
  }
  assert.ok(e.getRun(db, run.id).steps.every(s => s.status === 'completed'));
  const updated = memory.write(db, run.id, 'parent', { expected_revision: saved.revision, state: { ...state, next_actions: ['종료 후 갱신'] } });
  assert.notEqual(updated.revision, saved.revision);
  assert.deepEqual(memory.read(env.CODEX_ORCH_DB, run.id).state.next_actions, ['종료 후 갱신']);
  assert.equal(fs.existsSync(path.join(plugin, 'scripts/state.sqlite')), false);
});
