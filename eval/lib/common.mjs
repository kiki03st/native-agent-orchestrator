import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const EVAL = path.resolve(import.meta.dirname, '..');
export const REPO = path.resolve(EVAL, '..');
export const HOME = process.env.NAO_EVAL_HOME || path.join(os.homedir(), '.cache', 'nao-eval');
export const CASE_IDS = ['g1', 'g2', 'g3', 'g4', 'g5'];

export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
export const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
};
export const loadCase = (id) => ({ ...readJson(path.join(EVAL, 'cases', id, 'case.json')), id, planFile: path.join(EVAL, 'cases', id, 'plan.md') });
export const caseDir = (id) => path.join(HOME, 'cases', id);

export function sh(command, { cwd, env, timeout = 900000, check = true } = {}) {
  const result = spawnSync(command, { cwd, env: env || process.env, shell: true, encoding: 'utf8', timeout, maxBuffer: 1 << 28 });
  if (check && result.status !== 0) throw new Error(`Command failed (${result.status}): ${command}\n${(result.stderr || '').slice(-2000)}\n${(result.stdout || '').slice(-2000)}`);
  return result;
}

/** Removes a tree without following the node_modules junction into the shared dependency cache. */
export function removeTree(dir) {
  if (!fs.existsSync(dir)) return;
  const modules = path.join(dir, 'node_modules');
  try { if (fs.lstatSync(modules).isSymbolicLink()) fs.unlinkSync(modules); } catch {}
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

export function copyTree(from, to, skip = ['.git', 'node_modules']) {
  fs.cpSync(from, to, { recursive: true, filter: (source) => !skip.includes(path.basename(source)) });
}

export function caseEnv(testCase, base = process.env) {
  const env = { ...base, ...(testCase.env || {}) };
  if (testCase.runtime === 'python') {
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');
    env[pathKey] = path.join(caseDir(testCase.id), 'venv', 'Scripts') + path.delimiter + env[pathKey];
  }
  return env;
}

export function linkDeps(testCase, dir) {
  if (testCase.runtime !== 'node') return;
  fs.symlinkSync(path.join(caseDir(testCase.id), 'deps', 'node_modules'), path.join(dir, 'node_modules'), 'junction');
}
