// Recomputes saved results after a metric or scorer fix. Uses no model.
// Usage: node eval/remeasure.mjs [--rescore g4 g5]   Scores only change for the listed cases.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, loadCase, readJson, writeJson } from './lib/common.mjs';
import { evaluateBehavior, findTranscript, streamSummary, transcriptMetrics } from './lib/metrics.mjs';
import { scoreTree } from './lib/score.mjs';

const args = process.argv.slice(2);
const rescore = args[0] === '--rescore' ? args.slice(1) : [];
const root = path.join(HOME, 'results');
for (const condition of fs.readdirSync(root)) for (const id of fs.readdirSync(path.join(root, condition))) for (const rep of fs.readdirSync(path.join(root, condition, id))) {
  const dir = path.join(root, condition, id, rep), file = path.join(dir, 'result.json');
  if (!fs.existsSync(file)) continue;
  const record = readJson(file);
  const transcript = findTranscript(record.sessionId);
  if (!transcript) { console.log(`${condition}/${id}/${rep}: transcript missing, skipped`); continue; }
  const testCase = loadCase(id);
  record.stream = streamSummary(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8'));
  record.metrics = transcriptMetrics(transcript);
  if (rescore.includes(id)) {
    record.score = scoreTree(testCase, path.join(HOME, 'work', condition, id, rep));
    record.hiddenFailed = record.score.hidden.total - record.score.hidden.pass;
    record.regressionFailed = record.score.regression.total - record.score.regression.pass;
    console.log(`${condition}/${id}/${rep}: hidden ${record.score.hidden.pass}/${record.score.hidden.total}, regression ${record.score.regression.pass}/${record.score.regression.total}`);
  }
  record.behavior = evaluateBehavior(testCase.behavior, record);
  writeJson(file, record);
}
