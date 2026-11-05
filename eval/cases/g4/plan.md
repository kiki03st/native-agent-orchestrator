# 장바구니, 가격 재확인, 구매 기록, 쿠팡 차단 쿨다운

최저가 쇼핑 도우미의 다음 기능을 구현한다. 검색(`src/search/run.ts`), 실구매가(`src/pricing/calc.ts`), 웹 라우트(`src/web/routes.ts`), DB 스키마(`src/db.ts`)는 이미 있다. 스키마에 필요한 테이블도 이미 있으니 그대로 쓴다.

브라우저로 화면을 띄워 확인하지는 않는다. 실제 쇼핑몰에 접속하는 코드는 테스트에서 주입할 수 있어야 한다.

검증: `npm test`, `npm run typecheck`

## Task 1: 장바구니

`src/cart/cart.ts`, `src/web/pages/cart.ts`를 만들고 라우트를 추가한다.

```ts
export interface CartGroup { mall: MallId; addressId: number; addressLabel: string; items: CartItemRow[]; shipping: number; thresholdGap: number | null; subtotal: number; }
export function cartItems(db): CartItemRow[];   // cart_items 행 그대로
export function addToCart(db, hit: SearchHit, breakdown: Breakdown, parsed: ParsedTitle | null): number;
export function setQty(db, id: number, qty: number): void;  // 0이면 삭제
export function setAddress(db, id: number, addressId: number): void;
export function groups(db): CartGroup[];
export function totals(db): { items: number; discount: number; shipping: number; final: number; orderCount: number };
```

- 새 품목은 기본 배송지로 담긴다. 같은 URL을 다시 담으면 행을 늘리지 않고 수량을 올린다.
- 묶음은 (몰, 배송지) 단위다. 묶음 안의 `정가 × 수량` 합이 그 몰 문턱 이상이면 묶음 배송비는 0이고, 미달이면 배송비와 부족액을 묶음 단위로 다시 계산한다.
- `orderCount`는 묶음 수다.
- 라우트:
  - `POST /cart/add` (form `id`: 검색 결과 캐시의 hit id). 성공하면 302, 캐시에 없으면 404.
  - `POST /cart/:id/qty` (form `qty`), `POST /cart/:id/address` (form `address_id`)
  - `GET /cart`: 제목 "장바구니", 묶음 머리글 `쿠팡 · 집` 형식(몰 한글명 · 배송지 이름), 합계에 `몰 주문 N건`, `자동 결제`와 `수동 결제` 버튼. 결제 버튼의 실제 동작은 이번 범위가 아니다.

## Task 2: 가격 재확인

`src/cart/recheck.ts`를 만든다.

```ts
export type RecheckResult = { id: number; state: 'ok' | 'changed' | 'soldout' | 'failed'; oldPrice: number; newPrice: number | null };
export async function recheckAll(db, deps?: { check?: (mall: MallId, url: string) => Promise<{ listedPrice: number; shippingFee: number | null; soldOut: boolean }> }): Promise<RecheckResult[]>;
```

- 품목별로 독립 실행한다. 한 품목의 실패가 다른 품목에 영향을 주면 안 된다. 결과 순서는 담은 순서다.
- 결과는 행의 `recheck_state`에 저장한다.
  - 실패: `failed`, `current_price`는 건드리지 않는다.
  - 품절: `soldout`
  - 가격 동일: `ok`
  - 가격 변경: `changed`, `current_price`를 갱신하고 `breakdown_json`을 `realPrice`로 다시 계산한다.
- `createApp(db, deps?)`의 두 번째 인자는 `{ recheck?: check 함수 }`를 받는다.
- `POST /cart/recheck`는 재확인 뒤 `id="cart-body"` 조각만 돌려준다. `GET /cart`는 진입할 때 "확인 중" 표시와 함께 이 경로를 호출하고, 조각에는 "확인 중"이 없어야 한다.

## Task 3: 구매 기록, 주기 추천, 주문 대조

`src/history/purchases.ts`, `src/web/pages/history.ts`를 만들고, 메인 페이지의 "슬슬 떨어질 때"에 `dueSoon`을 연결한다.

```ts
export function recordPurchase(db, p: { mall: MallId; title: string; parsed: ParsedTitle | null; paidPrice: number; qty: number; orderNo?: string; route: 'auto' | 'manual' | 'newtab'; state: 'planned' | 'done' }): number;
export function markDone(db, id: number, paidPrice: number, orderNo: string | null): void;
export function softDelete(db, id: number): void;
export function cycleDays(dates: string[]): number | null;
export function dueSoon(db, today: string, leadDays = 5): Array<{ groupKey: string; title: string; cycleDays: number; lastAt: string; expectedAt: string; lastPrice: number; lastMall: MallId }>;
export function normalizeTitle(s: string): string;
export function titlesMatch(a: string, b: string): boolean;
export async function reconcilePlanned(db, deps?: { orderHistory?: (mall: MallId, since: string) => Promise<OrderRow[]> }): Promise<number>;
// OrderRow = { orderNo, title, price, qty, at }
```

- `cycleDays`: 2회 이상이면 평균 간격(일, 내림), 아니면 `null`. 입력 순서와 무관하고 날짜나 ISO 시각을 모두 받는다.
- `dueSoon`: 삭제되지 않은 완료 구매를 `group_key`로 묶어 `done_at` 기준으로 계산한다. `expectedAt`(`YYYY-MM-DD`) = 마지막 구매일 + 주기. 예상일이 `today + leadDays` 이내면 포함하고, 이미 지난 것도 포함한다.
- `normalizeTitle`: 대괄호, 공백, 특수문자와 끝의 개수 표기(`1개`)를 없앤다. `titlesMatch`: 정규화 후 한쪽이 다른 쪽을 포함하면 일치다.
- `reconcilePlanned`:
  - 같은 몰, `planned_at` 이후 주문 중 제목이 일치하면 `done`으로 바꾸고 `paid_price`와 `order_no`를 주문 값으로 채운다. 전환 수를 돌려준다.
  - 24시간이 지난 `planned`는 삭제한다.
  - `mall_accounts.connected = 0`인 몰은 주문 내역을 조회하지 않고, 해당 `planned`는 24시간 뒤 삭제만 한다.
- 라우트:
  - `POST /purchase/newtab` (form `id`: hit id): `route: 'newtab'`, `state: 'done'`으로 즉시 기록하고 200을 돌려준다. `paid_price`는 실구매가 `final`, `group_key`는 파싱 결과의 값이다.
  - `GET /history`: 삭제되지 않은 구매 목록과 `삭제` 버튼
  - `POST /history/:id/delete`: `softDelete`

## Task 4: 쿠팡 차단 쿨다운

`src/aside/malls/index.ts`, `coupang.ts`를 수정한다.

- `export class MallBlocked extends Error {}`, `export const blockedUntil = new Map<MallId, number>()`, 쿨다운 30분
- 쿠팡 검색 코드는 페이지가 접근 거부 화면("사용권한이 없습니다")이면 `{ host, blocked: true, items: [] }`를 낸다. `coupang.normalize`는 `blocked`가 참이면 `MallBlocked`를 던진다.
- `searchMall(mall, query, limit = 20, deps?: { run?: (code: string) => Promise<unknown> })`:
  - 쿨다운 중이면 레시피를 실행하지 않고 `MallBlocked`를 던진다.
  - `normalize`가 `MallBlocked`를 던지면 쿨다운을 기록한다.
