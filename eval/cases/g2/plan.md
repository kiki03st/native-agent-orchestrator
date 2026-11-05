# 쇼핑몰 검색 결과 파서 4개 추가

`src/aside/malls/danawa.ts`, `coupang.ts`와 같은 구조로 G마켓, 11번가, 올리브영, 네이버 레시피를 추가한다.
브라우저 없이는 검증할 수 없으므로 **이번 범위는 `normalize`와 등록까지**다.
각 레시피의 `searchCode`와 `priceCheckCode`는 `throw new Error('not implemented')`로 둔다.

공통 규칙:

- `normalize(raw)`는 `raw.items`를 읽어 `SearchHit[]`을 돌려준다. `items`가 없으면 빈 배열이다.
- 제목이나 링크가 없거나 광고(`ad: true`)이거나 양의 정수 가격을 얻지 못한 항목은 버린다.
- 가격은 `index.ts`의 `won()`으로 읽는다. 결과의 `mall`은 해당 몰 id, `ad`는 `false`다.
- `tests/fixtures/<몰>-search.json`에 실제 수집 raw 예시가 있다.
- 각 Task는 `src/aside/malls/index.ts`의 `recipes`에 자기 몰을 등록한다. 네 몰이 모두 등록되면 타입을 `Record<MallId, MallRecipe>`로 바꾼다.
- 검증: `npm test`, `npm run typecheck`

## Task 1: G마켓 (`gmarket.ts`, id `gmarket`)

raw 항목: `{ title, href, img, priceTexts: string[], tags: string[], ad }`

- 가격: `priceTexts`에서 `%`가 든 값을 빼고 읽은 숫자 중 **마지막 값**(판매가)
- 배송비: `tags`에서 `배송비` 또는 `무료배송`이 든 첫 항목. 무료면 0, 금액이 있으면 그 값, 태그가 없으면 `null`
- `url`: `href`에서 `&utparam-url=` 이후를 제거
- `imageUrl`: `//`로 시작하면 `https:`를 붙이고, 없으면 `null`
- `freeShipThreshold`, `reviewCount`, `rating`: `null`

## Task 2: 11번가 (`st11.ts`, id `st11`)

raw 항목: `{ title, href, img, priceText, deliveryText, text, ad }`

- 가격: `priceText` (`"160원~"`, `"17,000원"`)
- 배송비: `deliveryText`에 `무료`가 있으면 0, 금액이 있으면 그 값, 없으면 `null`
- `url`: `href`에서 `?` 이후를 제거. `imageUrl`: `img`
- `rating`: `text`의 `평점 4.5`, `reviewCount`: `text`의 `리뷰 (1,234)`. 없으면 `null`
- `freeShipThreshold`: `null`

## Task 3: 올리브영 (`oliveyoung.ts`, id `oliveyoung`)

raw 항목: `{ brand, name, href, img, curPrice, orgPrice, flags: string[] }`. 광고 필드는 없다.

- 가격: `curPrice`, 없으면 `orgPrice`
- 제목: `brand`가 있고 `name`에 포함되지 않으면 `"<brand> <name>"`, 아니면 `name`
- 배송비 2,500원, 무료 기준 20,000원을 상수로 두고 모든 결과에 넣는다
- `url`: `href`에서 `&trackingCd` 이후를 제거. `imageUrl`: `img`. `brandHint`: `brand`
- `reviewCount`, `rating`: `null`

## Task 4: 네이버 (`naver.ts`, id `naver`)

raw: `{ host, loginRequired?, items }`, 항목: `{ title, href, img, priceText, deliveryText, text, ad }`

- `export class MallLoginRequired extends Error {}`를 정의한다
- `raw.loginRequired`가 참이면 `MallLoginRequired`를 던진다
- 가격과 배송비: 11번가와 같은 규칙
- `url`: `href` 그대로. `imageUrl`: `img`
- `reviewCount`: `text`의 `리뷰 2,310`, `rating`: `text`의 `별점 4.8`. 없으면 `null`
- `freeShipThreshold`: `null`
