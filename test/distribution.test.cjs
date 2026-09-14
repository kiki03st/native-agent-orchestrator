const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const name = 'native-agent-orchestrator';

for (const runtime of ['codex', 'claude']) test(`${runtime} distributed hook works from a relocated path with spaces`, t => {
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
  const run = e.createRun(db, { runtime, objective: 'Package lifecycle', cwd: dir, steps: [{
    id: 'a', task: 'Check result', model: runtime === 'codex' ? 'gpt-5.6-sol' : 'sonnet', reasoning_effort: runtime === 'codex' ? 'high' : 'medium',
    reason: 'Review', depends_on: [], read_paths: [], write_paths: [], acceptance: ['Parent verified']
  }] }, 'parent');
  const input = e.prepare(db, run.id, 'a');
  assert.deepEqual(hook({ hook_event_name: 'PreToolUse', tool_name: runtime === 'codex' ? 'spawn_agent' : 'Agent', tool_use_id: 'call', tool_input: input }), {});
  if (runtime === 'claude') {
    hook({ hook_event_name: 'SubagentStart', agent_id: 'worker', agent_type: input.subagent_type });
    hook({ hook_event_name: 'SubagentStop', agent_id: 'worker', agent_type: input.subagent_type, effort: { level: 'medium' } });
  } else {
    hook({ hook_event_name: 'PostToolUse', tool_name: 'spawn_agent', tool_use_id: 'call', tool_input: input, tool_response: { agent_id: 'worker' } });
  }
  assert.equal(e.getRun(db, run.id).steps[0].closed, false);
  e.report(db, run.id, 'a', { agent_id: 'worker', call_id: 'call', summary: 'Verified', verified: true, evidence: ['Fixture checked'], changed_files: [],
    execution_complete: true, completion_evidence: 'Native result fixture', observed_model: 'claude-sonnet-5', observed_effort: 'medium' });
  if (runtime === 'codex') hook({ hook_event_name: 'PostToolUse', tool_name: 'close_agent', tool_input: { target: 'worker' }, tool_response: { previous_status: { completed: 'Done' } } });
  assert.equal(e.getRun(db, run.id).steps[0].closed, true);
  assert.equal(fs.existsSync(path.join(plugin, 'scripts/state.sqlite')), false);
});
