# 제목 파싱, 할인 행사, 실구매가 구현 검토와 수정

이전 작업자가 아래 세 모듈을 구현하고 완료로 보고했다. `npm test`와 `npm run typecheck`는 통과하지만, 테스트가 다루지 않는 규칙 위반이 있을 수 있다.

## Task 1: 규칙과 코드를 대조해 어긋난 곳을 모두 고치기

- 아래 규칙을 코드와 하나씩 대조해 어긋난 곳을 찾아 고친다. 몇 개인지는 알려지지 않았다.
- 규칙에 맞는 동작은 바꾸지 않는다. 공개 함수의 시그니처도 바꾸지 않는다.
- 고친 곳마다 회귀 테스트를 추가한다.
- 검증: `npm test`, `npm run typecheck`

## 규칙

### `src/llm/titles.ts`

- 캐시에 있는 제목은 `exec`에 보내지 않고, 미스만 한 번에 보낸다.
- `parseResponse`는 코드펜스를 무시하고 JSON을 읽어 길이와 필드를 검증한다. 실패하면 `null`이다.
- 응답 항목은 `i` 필드로 입력 제목과 맞춘다. 응답 순서는 입력 순서와 다를 수 있다.
- 응답을 해석하지 못했거나 `exec`가 실패하면 1회 재시도한다. 또 실패하면 미스 항목은 `{brand: null, product: null, volumeMl: null, count: 1, optionSelect: false, isSet: false, groupKey: null}`로 채우고 캐시하지 않는다.
- `groupKey`는 `brand|product|volumeMl`을 소문자, 공백 제거로 정규화해 다시 만든다. 택1 상품이거나 브랜드와 제품명이 모두 없으면 `null`이다.

### `src/llm/promos.ts`

- `parsePromoResponse`는 알 수 없는 `pay_code`나 `kind`, 0 이하의 `value`를 가진 항목을 버린다.
- `fetchPromos`는 URL별로 페이지 텍스트 → 추출 → `promos` 테이블 교체 순서로 처리한다. 해석에 실패하면 1회 재시도한다.
- 페이지를 못 읽었거나 추출에 끝내 실패한 URL은 그 URL의 기존 규칙을 그대로 유지한다.
- `activePromos`는 시작일과 종료일을 포함한 기간 안의 규칙 중 `payment_profile`에서 켜진 결제수단만 돌려준다.

### `src/pricing/calc.ts`

- 결제 할인은 해당 몰의 규칙, 사용자가 켠 결제수단, 시작일과 종료일을 포함한 기간 안에 있는 규칙만 후보다.
- 후보 중 적용 가능한 **최대 1개**만 쓴다.
- `minAmount`는 정가가 그 금액 **이상**이면 충족이다. 미달이면 적용하지 않고 `notes`에 남긴다.
- `condition`이 비어 있지 않으면 해석할 수 없으므로 적용하지 않고 `notes`에 "조건 확인 필요"를 남긴다.
- `percent`는 `min(정가 × value / 100, maxDiscount)`이며 원 단위로 **내림**한다. 모든 금액은 정수다.
- `point`는 합계에 포함하고 `notes`에 "적립"을 남긴다.
- 배송비: `freeShipThreshold`가 있고 정가가 그 이상이면 0이다. 미달이면 `shippingFee`를 쓰고 `thresholdGap`에 부족액을 넣는다. 문턱이 없으면 `shippingFee`이고, 그것도 없으면 0과 함께 `notes`에 "배송비 확인 필요"를 남긴다.
- `final = listed − coupon − payDiscount − membership − point + shipping`
- `perUnit`: 용량이 있으면 `(할인 후 금액) / (용량 × 개수)`, 용량 없이 2개 이상이면 개당 금액이다.
