import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEYS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
const POLICY_MARKERS = ['[Claude native orchestration policy]', '[Native orchestration policy]'];

export function findTranscript(sessionId, root = path.join(os.homedir(), '.claude', 'projects')) {
  for (const project of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const file = path.join(root, project, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

const emptyRow = () => ({ turns: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
const emptyUsage = () => ({ ...emptyRow(), byModel: {} });

function addRow(total, model, row) {
  total.turns += row.turns;
  const target = (total.byModel[model] ||= emptyRow());
  target.turns += row.turns;
  for (const key of KEYS) { total[key] += row[key] || 0; target[key] += row[key] || 0; }
}

function scan(file) {
  const usage = emptyUsage(), tools = {}, seen = new Set(), commands = [];
  let policy = 0, first = null, last = null;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (row.timestamp) { const time = Date.parse(row.timestamp); first ??= time; last = time; }
    if (row.attachment && POLICY_MARKERS.some((marker) => line.includes(marker))) policy++;
    if (row.type !== 'assistant') continue;
    const message = row.message || {};
    if (message.usage && message.model !== '<synthetic>' && !seen.has(message.id)) {
      seen.add(message.id);
      addRow(usage, message.model, { ...message.usage, turns: 1 });
    }
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type !== 'tool_use') continue;
      tools[block.name] = (tools[block.name] || 0) + 1;
      if (['Bash', 'PowerShell'].includes(block.name) && block.input?.command) commands.push(block.input.command);
    }
  }
  return { usage, tools, policy, first, last, commands };
}

export function overlapMs(intervals) {
  const sorted = intervals.filter(([start, end]) => start != null && end != null).sort((a, b) => a[0] - b[0]);
  let total = 0, reach = -Infinity;
  for (const [start, end] of sorted) { if (start < reach) total += Math.min(end, reach) - start; reach = Math.max(reach, end); }
  return total;
}

const isCheap = (model) => !/opus|fable/i.test(model);

export function transcriptMetrics(mainFile) {
  const main = scan(mainFile);
  const dir = path.join(mainFile.slice(0, -'.jsonl'.length), 'subagents');
  const subs = fs.existsSync(dir) ? fs.readdirSync(dir).filter((file) => file.endsWith('.jsonl')).map((file) => scan(path.join(dir, file))) : [];
  const subUsage = emptyUsage();
  for (const sub of subs) for (const [model, row] of Object.entries(sub.usage.byModel)) addRow(subUsage, model, row);
  const cheapTurns = Object.entries(subUsage.byModel).filter(([model]) => isCheap(model)).reduce((total, [, row]) => total + row.turns, 0);
  const allCommands = [...main.commands, ...subs.flatMap((sub) => sub.commands)];
  return {
    main: main.usage, subagents: subUsage, subagentCount: subs.length,
    agentCalls: (main.tools.Agent || 0) + (main.tools.Task || 0),
    sendMessages: main.tools.SendMessage || 0,
    orchestratorCliCalls: main.commands.filter((command) => command.includes('cli.cjs')).length,
    policyInjections: main.policy,
    cheapSubagentTurnShare: subUsage.turns ? cheapTurns / subUsage.turns : 0,
    parallelOverlapMs: overlapMs(subs.map((sub) => [sub.first, sub.last])),
    // Overlap as a share of total worker time, so a few seconds of accidental overlap does not count as parallel work.
    parallelShare: (() => {
      const total = subs.reduce((sum, sub) => sum + ((sub.last ?? 0) - (sub.first ?? 0)), 0);
      return total > 0 ? overlapMs(subs.map((sub) => [sub.first, sub.last])) / total : 0;
    })(),
    // Tool names must stand alone: g2's own source lives under src/aside.
    leakSuspects: allCommands.filter((command) => /github\.com|(^|[\s;&|(])gh\s|(^|[\s;&|(])aside(\.exe)?\s/i.test(command)).length,
    // Wall clock from the transcript: stream results only cover the stretch since the last background wake-up.
    wallMs: Math.max(main.last ?? 0, ...subs.map((sub) => sub.last ?? 0)) - (main.first ?? 0),
  };
}

/** The final stream-json `result` and first `init` events. */
export function streamSummary(text) {
  let init = null, result = null, turns = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (row.type === 'system' && row.subtype === 'init') init ??= row;
    // A run with background agents emits several results: cost is cumulative, turns are per stretch.
    if (row.type === 'result') { result = row; turns += row.num_turns || 0; }
  }
  return {
    costUsd: result?.total_cost_usd ?? null, turns: result ? turns : null,
    isError: result ? !!result.is_error : true, subtype: result?.subtype ?? 'no_result',
    // An account limit says nothing about the method under test, so such a run must not be scored.
    limitHit: !!result?.is_error && /hit your .*limit/i.test(result.result || ''),
    plugins: (init?.plugins || []).map((plugin) => plugin.name), mcpServers: (init?.mcp_servers || []).map((server) => server.name),
    skills: init?.skills || [], claudeVersion: init?.claude_code_version ?? null, model: init?.model ?? null,
  };
}

const OPS = { eq: (a, b) => a === b, gte: (a, b) => a >= b, gt: (a, b) => a > b, lte: (a, b) => a <= b };
const lookup = (object, dotted) => dotted.split('.').reduce((value, key) => value?.[key], object);

export function evaluateBehavior(rules, record) {
  return (rules || []).map((rule) => {
    const actual = lookup(record, rule.metric);
    return { id: rule.id, metric: rule.metric, expected: `${rule.op} ${rule.value}`, actual, pass: actual !== undefined && OPS[rule.op](actual, rule.value) };
  });
}
