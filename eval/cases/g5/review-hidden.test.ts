import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realPrice } from '../src/pricing/calc.ts';
import { parseResponse, parseTitles } from '../src/llm/titles.ts';
import { fetchPromos, type PromoRule } from '../src/llm/promos.ts';
import { openDb } from '../src/db.ts';
import type { SearchHit } from '../src/aside/types.ts';

const TODAY = '2026-10-26';
const hit = (o: Partial<SearchHit> = {}): SearchHit => ({ mall: 'coupang', title: 't', url: 'u', imageUrl: null, listedPrice: 20000, shippingFee: 0, freeShipThreshold: null, ...o });
const promo = (o: Partial<PromoRule> = {}): PromoRule => ({ mall: 'coupang', payCode: 'shinhan', kind: 'percent', value: 5, minAmount: null, maxDiscount: null, starts: null, ends: null, condition: null, sourceUrl: 'u', ...o });
const card = { enabled: new Set(['shinhan']) };
const item = (i: number, brand: string) => ({ i, brand, product: 'P', volume_ml: 1, count: 1, option_select: false, is_set: false, group: 'g' });

test('D1 promo is still valid on its end date', () => {
  assert.equal(realPrice(hit(), null, card, [promo({ ends: TODAY })], TODAY).payDiscount, 1000);
});

test('D2 percent discount is rounded down', () => {
  assert.equal(realPrice(hit({ listedPrice: 19999 }), null, card, [promo()], TODAY).payDiscount, 999);
});

test('D3 listed price equal to minAmount qualifies', () => {
  assert.equal(realPrice(hit({ listedPrice: 30000 }), null, card, [promo({ kind: 'amount', value: 1000, minAmount: 30000 })], TODAY).payDiscount, 1000);
});

test('D4 a promo from another mall never applies', () => {
  assert.equal(realPrice(hit(), null, card, [promo({ mall: 'gmarket' })], TODAY).payDiscount, 0);
});

test('D5 exec failures retry once and then fall back to defaults', async () => {
  let calls = 0;
  const r = await parseTitles(['x'], { db: openDb(':memory:'), exec: async () => { calls++; throw new Error('boom'); } });
  assert.equal(calls, 2);
  assert.equal(r[0].groupKey, null);
});

test('D6 response items are matched by their i field, not their position', () => {
  const r = parseResponse(JSON.stringify([item(1, 'B'), item(0, 'A')]), ['a', 'b']);
  assert.deepEqual(r?.map((x) => x.brand), ['A', 'B']);
});

test('D7 a failed promo fetch keeps the previous rules', async () => {
  const db = openDb(':memory:');
  const exec = async () => '[{"pay_code":"shinhan","kind":"percent","value":5}]';
  await fetchPromos('gmarket', { db, urls: ['u'], pageText: async () => 'text', exec });
  await fetchPromos('gmarket', { db, urls: ['u'], pageText: async () => { throw new Error('down'); }, exec });
  assert.equal((db.prepare('select count(*) c from promos').get() as { c: number }).c, 1);
});
