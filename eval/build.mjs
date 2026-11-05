import { buildAll } from './lib/fixture.mjs';

const ids = process.argv.slice(2);
const { plugins, metas } = buildAll(ids.length ? ids : undefined);
console.log('plugins', plugins);
for (const meta of metas) {
  console.log(`${meta.case}: 숨은 테스트 ${meta.hidden.length}개, 회귀 테스트 ${meta.regression.length}개, 정답에서도 실패 ${meta.failingOnSolution.length}개, 타입체크 ${JSON.stringify(meta.typecheck)}`);
}
