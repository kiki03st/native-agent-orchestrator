'use strict';
// Generated distribution files are intentionally committed: installation needs no build.
const fs = require('node:fs');
const path = require('node:path');
const repo = path.resolve(__dirname, '..');
const name = 'native-agent-orchestrator';
const check = process.argv.includes('--check');
const files = ['engine.cjs', 'policy.json', 'cli.cjs', 'memory.cjs', 'hook.cjs', 'coordinator.md', 'claude-hook.cjs', 'claude-adapter.cjs', 'claude-coordinator.md'];
const mismatches = [];
function emit(relative, body) {
  const filename = path.join(repo, relative);
  if (check) {
    if (!fs.existsSync(filename) || fs.readFileSync(filename, 'utf8') !== body) mismatches.push(relative);
  } else {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, body, 'utf8');
  }
}
function json(relative, value) { emit(relative, JSON.stringify(value, null, 2) + '\n'); }
for (const base of ['plugins', 'claude-plugins']) {
  for (const file of files) emit(`${base}/${name}/scripts/${file}`, fs.readFileSync(path.join(repo, 'src', file), 'utf8').replace(/\r\n/g, '\n'));
}
const codexCommand = `node -e "require(require('node:path').join(process.env.PLUGIN_ROOT,'scripts','hook.cjs'))"`;
const codex = (event, matcher, limit) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: codexCommand, timeout: 5,
  statusMessage: `Native Agent Orchestrator: ${event}`, ...(limit ? { additionalContextLimit: limit } : {}) }] });
json(`plugins/${name}/hooks/hooks.json`, { description: 'Explicit planned models and native worker lifecycle.', hooks: {
  UserPromptSubmit: [codex('UserPromptSubmit', null, 10000)],
  SubagentStart: [codex('SubagentStart', null, 1000)],
  PreToolUse: [codex('PreToolUse', '^(Agent|spawn_agent|multi_agent_v1[.]spawn_agent|multi_agent_v1__spawn_agent|collaboration[.]spawn_agent|collaboration__spawn_agent)$')],
  PostToolUse: [codex('PostToolUse', '^(Agent|spawn_agent|close_agent|multi_agent_v1[.](spawn_agent|close_agent)|multi_agent_v1__(spawn_agent|close_agent)|collaboration[.](spawn_agent|list_agents|wait_agent)|collaboration__(spawn_agent|list_agents|wait_agent))$')]
} });
const claude = (event, matcher) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: 'node',
  args: ['${CLAUDE_PLUGIN_ROOT}/scripts/claude-hook.cjs'], timeout: 5, statusMessage: `Native Agent Orchestrator: ${event}` }] });
json(`claude-plugins/${name}/hooks/hooks.json`, { description: 'Native Claude orchestration with plugin-scoped model and effort profiles.', hooks: {
  UserPromptSubmit: [claude('UserPromptSubmit')],
  PreToolUse: [claude('PreToolUse', '^(Agent|Task)$')],
  PostToolUse: [claude('PostToolUse', '^(Agent|Task)$')],
  PostToolUseFailure: [claude('PostToolUseFailure', '^(Agent|Task)$')],
  SubagentStart: [claude('SubagentStart', '^native-agent-orchestrator:orch-')],
  SubagentStop: [claude('SubagentStop', '^native-agent-orchestrator:orch-')]
} });
for (const [profile, body] of Object.entries(require('../src/claude-adapter.cjs').profiles())) emit(`claude-plugins/${name}/agents/${profile}.md`, body);
if (mismatches.length) { process.stderr.write('Distribution differs from source:\n' + mismatches.join('\n') + '\n'); process.exitCode = 1; }
else process.stdout.write(check ? 'Distribution matches source.\n' : 'Built Codex and Claude Code plugins (18 Claude worker profiles).\n');
