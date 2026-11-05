// Aggregates results/ and applies gate.json. Usage: node eval/compare.mjs
import fs from 'node:fs';
import path from 'node:path';
import { CASE_IDS, EVAL, HOME, readJson } from './lib/common.mjs';
import { aggregate, decide } from './lib/gate.mjs';

function loadResults(root) {
  const results = [];
  for (const condition of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    for (const id of fs.readdirSync(path.join(root, condition))) {
      for (const rep of fs.readdirSync(path.join(root, condition, id))) {
        const file = path.join(root, condition, id, rep, 'result.json');
        if (fs.existsSync(file)) results.push(readJson(file));
      }
    }
  }
  return results;
}

const percent = (value) => (value == null ? '-' : `${Math.round(value * 100)}%`);
const number = (value, digits = 0) => (value == null ? '-' : Number(value).toFixed(digits));

export function renderReport(table, gate, cases) {
  const lines = ['# 골든 케이스 비교', '', '| 조건 | 케이스 | 실행 | 숨은 테스트 | 회귀 | 함정 | 비용(중앙값) | 토큰(중앙값) | 시간(분) | 위임 | 동작 기준 | 유출 의심 |', '|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|'];
  for (const [condition, rows] of Object.entries(table)) for (const id of cases) {
    const row = rows[id];
    if (!row) continue;
    lines.push(`| ${condition} | ${id} | ${row.n} | ${percent(row.hidden)} | ${percent(row.regression)} | ${percent(row.trap)} | ${row.costUsd == null ? '-' : '$' + number(row.costUsd, 2)} | ${number(row.tokens)} | ${number(row.durationMs == null ? null : row.durationMs / 60000, 1)} | ${number(row.agentCalls)} | ${percent(row.behavior)} | ${row.leakSuspects} |`);
  }
  lines.push('', `## ${gate.baseline} 대체 판정`, '');
  const challengers = Object.keys(table).filter((name) => name !== gate.baseline);
  if (!challengers.length) lines.push('도전 조건 결과가 아직 없습니다.');
  for (const name of challengers) {
    const verdict = decide(table, name, gate, cases);
    lines.push(`- **${name}: ${verdict.verdict}**`, ...verdict.reasons.map((reason) => `  - ${reason}`));
    // inline delegates nothing, so if it passes, the cases cannot tell what delegation buys.
    if (name === 'inline' && verdict.verdict === 'REPLACE_CANDIDATE') lines.push('  - 경고: 위임 없는 기준선이 통과했습니다. 품질로는 위임의 이득을 가르지 못한 결과입니다.');
  }
  return lines.join('\n') + '\n';
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const table = aggregate(loadResults(path.join(HOME, 'results')));
  const report = renderReport(table, readJson(path.join(EVAL, 'gate.json')), CASE_IDS);
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'report.md'), report);
  console.log(report);
}
