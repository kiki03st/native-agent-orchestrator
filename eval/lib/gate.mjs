const median = (values) => {
  const sorted = values.filter((value) => typeof value === 'number').sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const ratio = (part) => (part && part.total ? part.pass / part.total : 0);
const TOKEN_KEYS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
const tokens = (run) => ['main', 'subagents'].reduce((sum, side) => sum + TOKEN_KEYS.reduce((inner, key) => inner + (run.metrics?.[side]?.[key] || 0), 0), 0);

export function aggregate(results) {
  const table = {};
  for (const result of results) if (!result.stream?.limitHit) ((table[result.condition] ||= {})[result.case] ||= []).push(result);
  const out = {};
  for (const [condition, cases] of Object.entries(table)) {
    out[condition] = {};
    for (const [id, runs] of Object.entries(cases)) {
      const behavior = runs.flatMap((run) => run.behavior || []);
      const hasTrap = runs.some((run) => run.score?.trapCaught !== null && run.score?.trapCaught !== undefined);
      out[condition][id] = {
        n: runs.length,
        completed: runs.filter((run) => !run.stream?.isError).length,
        hidden: mean(runs.map((run) => ratio(run.score?.hidden))),
        regression: mean(runs.map((run) => ratio(run.score?.regression))),
        trap: hasTrap ? mean(runs.map((run) => (run.score?.trapCaught ? 1 : 0))) : null,
        costUsd: median(runs.map((run) => run.stream?.costUsd)),
        tokens: median(runs.map(tokens)),
        durationMs: median(runs.map((run) => run.metrics?.wallMs)),
        agentCalls: median(runs.map((run) => run.metrics?.agentCalls)),
        behavior: behavior.length ? behavior.filter((rule) => rule.pass).length / behavior.length : null,
        leakSuspects: runs.reduce((sum, run) => sum + (run.metrics?.leakSuspects || 0), 0),
      };
    }
  }
  return out;
}

/** Applies the thresholds fixed in gate.json. Anything unmeasured makes the verdict INCONCLUSIVE, never a pass. */
export function decide(table, challenger, gate, cases) {
  const base = table[gate.baseline], test = table[challenger];
  const missing = cases.filter((id) => (base?.[id]?.n ?? 0) < gate.minReps || (test?.[id]?.n ?? 0) < gate.minReps
    || base?.[id]?.costUsd == null || test?.[id]?.costUsd == null);
  if (missing.length) return { challenger, verdict: 'INCONCLUSIVE', reasons: [`측정 부족: ${missing.join(', ')} (조건별 최소 ${gate.minReps}회와 비용 필요)`], checks: [] };
  const checks = [];
  const check = (id, pass, detail) => checks.push({ id, pass, detail });
  for (const id of cases) {
    const a = test[id], b = base[id];
    check(`${id}:hidden`, a.hidden >= b.hidden - gate.qualityTolerance, `${a.hidden.toFixed(3)} vs ${b.hidden.toFixed(3)}`);
    check(`${id}:regression`, a.regression >= b.regression - gate.qualityTolerance, `${a.regression.toFixed(3)} vs ${b.regression.toFixed(3)}`);
    if (b.trap !== null) check(`${id}:trap`, a.trap >= b.trap, `${a.trap.toFixed(2)} vs ${b.trap.toFixed(2)}`);
    check(`${id}:cost-per-case`, a.costUsd <= b.costUsd * gate.maxCaseCostRatio, `$${a.costUsd.toFixed(2)} vs $${b.costUsd.toFixed(2)}`);
  }
  const sum = (side) => cases.reduce((total, id) => total + side[id].costUsd, 0);
  check('total-cost', sum(test) <= sum(base) * gate.maxTotalCostRatio, `$${sum(test).toFixed(2)} vs $${sum(base).toFixed(2)} (상한 ${gate.maxTotalCostRatio}배)`);
  for (const id of gate.behaviorCases) check(`${id}:behavior`, (test[id].behavior ?? 0) >= gate.minBehaviorRate, `${(test[id].behavior ?? 0).toFixed(2)} (하한 ${gate.minBehaviorRate})`);
  const failed = checks.filter((item) => !item.pass);
  return { challenger, verdict: failed.length ? 'NOT_YET' : 'REPLACE_CANDIDATE', reasons: failed.map((item) => `${item.id}: ${item.detail}`), checks };
}
