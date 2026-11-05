# 전략에 CCI(20) +100 돌파 구성요소 추가

전략 목표 비중을 **추세·변동성 비중 + CCI 돌파 보유 비중**으로 섞을 수 있게 한다.
기본값(`cciWeight: 0`)이면 지금과 결과가 완전히 같아야 한다.

**완료 조건: 전략 설정에 `cciWeight > 0`인 버전을 추가하면 바로 운영에 쓸 수 있어야 한다.**

전체 검증: `npm run check`. 기존 테스트를 지우거나 skip하지 않는다. 외부 모델 러너(`npm run agent`)와 네트워크가 필요한 명령은 쓰지 않는다.

## Task 1: 계산과 설정

### `src/strategy/indicators.ts`

```ts
/**
 * CCI(n): (전형가 − 최근 n일 전형가 평균) ÷ (0.015 × 평균 절대 편차).
 * 전형가 = (고가 + 저가 + 종가) / 3. 평균 절대 편차 = 최근 n일 전형가와 그 n일 평균의 차이 절댓값의 평균.
 * 창이 덜 찼거나, 창 안에 null·유한하지 않은 값이 있거나, 평균 절대 편차가 0이면 null.
 * 세 배열 길이가 다르면 RangeError. n이 2 미만 정수가 아니면 RangeError.
 */
export function cci(highs: (number | null)[], lows: (number | null)[], closes: (number | null)[], n: number): (number | null)[];
```

기대값 예시 (n=4, 소수 8자리까지 일치):

- highs `[10, 11, 12, 11, 13, 14, 13, 15, 16, 15]`
- lows `[8, 9, 10, 9, 11, 12, 11, 13, 14, 13]`
- closes `[9, 10, 11, 10, 12, 13, 12, 14, 15, 14]`
- 결과 `[null, null, null, 0, 111.1111111111, 100, 19.0476190476, 111.1111111111, 100, 19.0476190476]`

### `src/strategy/trend-vol.ts`

```ts
export interface TrendVolParams {
  // ...기존 항목 그대로
  cciWeight: number; // CCI 돌파 보유에 줄 비중 (0 이상 1 이하, 0이면 쓰지 않음)
  cciPeriod: number; // CCI 기간 (2 이상 정수)
  cciLevel: number;  // CCI 돌파 기준선 (유한한 수)
}
// DEFAULT_TREND_VOL에 일반(열거되는) 속성으로 cciWeight: 0, cciPeriod: 20, cciLevel: 100 을 추가한다.

export interface HighLow {
  highs: Record<string, (number | null)[]>;
  lows: Record<string, (number | null)[]>;
}

/**
 * CCI 돌파 보유 상태 (날짜별, 그날 종가 기준).
 * - 보유 중이 아닐 때: 전날 CCI ≤ level 이고 오늘 CCI > level 이면 보유 시작 (전날 CCI가 null이면 시작하지 않음)
 * - 보유 중일 때: 오늘 CCI < level 이면 보유 끝 (정확히 level이면 계속 보유)
 * - 오늘 CCI가 null이면 전날 상태를 그대로 쓴다. 첫날 이전 상태는 false.
 */
export function cciStates(values: (number | null)[], level: number): boolean[];

export function targetWeightsSeries(closes: Record<string, (number | null)[]>, params?: Partial<TrendVolParams>, highLow?: HighLow): Record<string, number>[];
export function latestTargets(closes: Record<string, (number | null)[]>, params?: Partial<TrendVolParams>, highLow?: HighLow): TargetDetail[];
```

- `validatedParams` 오류 메시지:
  - "cciWeight는 0 이상 1 이하여야 함"
  - "cciPeriod는 2 이상 정수여야 함"
  - "cciLevel은 유한한 수여야 함"
- `targetWeightsSeries`:
  - `cciWeight === 0`이면 지금과 완전히 같은 결과를 낸다. highLow는 없어도 되고 있어도 무시한다.
  - `cciWeight > 0`인데 highLow가 없거나, closes에 있는 마켓의 highs·lows가 없거나 길이가 다르면 `RangeError("CCI 구성요소에는 마켓별 고가·저가가 필요합니다: <마켓>")`.
  - 날짜 i에서 기존 방식의 비중(grossCap 적용 뒤)을 `tv[m]`, CCI 보유 상태를 `on[m]`이라 할 때:
    - `available` = 그날 추세 점수가 있는 마켓 수
    - 마켓 m의 CCI 몫 = `available > 0`이고 m의 추세 점수와 종가가 그날 있고 `on[m]`이면 `1 / available`, 아니면 0
    - `w[m] = (1 − cciWeight) × tv[m] + cciWeight × CCI 몫`
    - 합이 `grossCap`보다 크면 비율을 유지하며 합이 `grossCap`이 되도록 줄인다
- `latestTargets`는 섞은 비중의 마지막 날 값을 `weight`로 쓴다. `score`와 `vol`은 그대로이고 `TargetDetail` 타입은 바꾸지 않는다.

### `src/strategy/config.ts`

- 전략 버전의 `strategy`가 `cciWeight`, `cciPeriod`, `cciLevel`을 받는다. 파일에 적힌 항목만 담는 지금 방식은 유지한다.
- 값 검증은 `validatedParams`로 한다. `cciWeight: 2`는 오류이고 메시지에 `versions[0]`과 `cciWeight`가 들어간다. 모르는 키는 지금처럼 "알 수 없는 전략 항목" 오류다.

### `src/research/improve.ts`

- 후보 파일의 `strategy`가 같은 세 항목을 받는다.
- `isSameAsCurrent`가 CCI 항목도 비교한다.
- `cciWeight`는 위험 구조를 바꾸는 항목으로 `RISK_KEYS`에 추가한다. `cciPeriod`와 `cciLevel`은 위험 항목이 아니다.
- `nextVersion`이 만든 버전은 CCI 항목을 포함해도 `parseStrategyConfig`를 통과해야 한다.
- 채택 기준(`ACCEPTANCE`, `judge`)은 바꾸지 않는다. `config/*.json`은 수정하지 않는다.

## Task 2: 일봉 정렬과 백테스트

```ts
// src/data/bars.ts
export interface AlignedCloses {
  dates: string[];
  closes: Record<string, (number | null)[]>;
  highs?: Record<string, (number | null)[]>; // 직접 만든 정렬 자료에는 없을 수 있다
  lows?: Record<string, (number | null)[]>;
}
```

- `alignCloses`는 종가를 맞추는 방식 그대로 `bar.high`, `bar.low`도 맞춰 항상 `highs`, `lows`를 채운다. 빠진 날은 null이다.
- `runStrategyBacktest`는 `highs`와 `lows`가 둘 다 있으면 `targetWeightsSeries`에 세 번째 인자로 넘기고, 하나라도 없으면 넘기지 않는다.
- 동일 비중 비교 대상과 체결 계산(`runBacktest`)은 바꾸지 않는다.
