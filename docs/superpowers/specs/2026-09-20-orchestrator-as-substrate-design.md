# 오케스트레이터를 기반층으로 — 설계 (개정 2)

**날짜:** 2026-09-20
**대상:** `native-agent-orchestrator` 0.1.0 → 0.2.0
**개정 사유:** 초판이 냉정한 컨텍스트 리뷰에서 다수의 사실 오류와 거짓 합격 기준을 지적받았고, 이어진 경계 걷기에서 미결 질문 18개가 드러났다. 이 개정판은 그 둘을 반영한다.

**증거 표기:** `[레포]` 는 이 저장소에서 확인 가능한 주장, `[세션]` 은 이 머신의 세션 트랜스크립트·원장 측정에 의존하며 저장소가 확증하지 않는 주장이다.

---

## 1. 문제

### 1.1 훅이 계획에 없는 모든 서브에이전트 위임을 거부한다

`[레포]` Claude 쪽에서 실제로 차단하는 것은 **마커 검사가 아니라 프로필 검사**다. `src/claude-hook.cjs:17`:

```js
if(event.agent_id)throw new Error('Worker cannot recursively delegate');   // :16
a.checkProfile(event.tool_input,event.cwd);db=e.openDb();                  // :17  ← 여기서 throw
e.reserve(db,event.tool_input,event.session_id,event.tool_use_id,'claude'); // :18  ← 마커 검사
```

`src/claude-adapter.cjs:18` 은 `subagent_type` 이 `native-agent-orchestrator:` 로 시작하지 않으면 첫 줄에서 throw하고, `src/claude-hook.cjs:36` 이 그것을 `permissionDecision:'deny'` 로 바꾼다. 따라서 `general-buddy`·`Explore`·`general-purpose` 디스패치는 **마커 검사에 도달조차 하지 못한다.**

Codex 쪽은 반대로 마커 검사가 차단한다. `src/hook.cjs:30` 이 `e.reserve()` 를 무조건 호출하고, `src/engine.cjs:123` 의 `need(match,'Missing plan marker; …')` 가 throw한다.

**이것은 사고가 아니라 의도된 계약이다.** `src/test/hooks.test.cjs:30` 이 그것을 요구사항으로 고정한다:

```js
const deny=hook({hook_event_name:'PreToolUse',tool_name:'spawn_agent',tool_input:{message:'unplanned'}});
assert.equal(deny.hookSpecificOutput.permissionDecision,'deny');
```

`[레포]` 그리고 이것이 **44개 테스트 중 마커 없는 디스패치를 건드리는 유일한 단언**이다. Claude 쪽 차단은 어떤 테스트도 고정하지 않으므로, 오늘 어느 방향으로 바꿔도 43 pass로 초록이다.

### 1.2 측정된 영향

`[세션]` 플러그인 설치일 2026-09-14 전후, 트랜스크립트의 Agent/Task 툴 호출과 생성된 `subagents/agent-*.jsonl` 파일 수:

| | 디스패치 시도 | 생성된 워커 | 성공률 |
|---|---:|---:|---:|
| 설치 전 | 119 | 118 | 99.2% |
| 설치 후 | 27 | 14 | 51.9% |

`[세션]` subagent-driven-development 를 실제로 사용한 유일한 프로젝트(lolchess, 세션 `3897cabb`)에서는 이틀에 걸친 Agent 디스패치 **10회가 전부 실패**했다. 툴 결과를 직접 확인한 내역: 5회는 훅의 `Expected plugin-qualified Claude worker profile` 거부, 5회는 `InputValidationError`(모델 파라미터 값 오류). 컨트롤러는 그 뒤 12개 과제를 `Edit` 345회 / `Write` 171회로 직접 수행했다.

**주의:** 위 5회의 `InputValidationError` 는 이 설계가 고치는 대상이 아니다. 따라서 "성공률 100%" 는 이 설계의 목표가 될 수 없다 — §6.1 참조.

### 1.3 프로토콜 세금

`[세션]` 통제된 파일럿 (읽기 전용 1스텝, haiku/default, 원장 run `10025e0a`):

| 항목 | 실측 |
|---|---:|
| 프로토콜 필수 오케스트레이터 턴 | 6 |
| 그 6턴의 컨텍스트 토큰 | 897,754 |
| 그 6턴의 출력 토큰 | 10,433 |
| 워커 자체 비용 | 25,229 |
| 오버헤드 : 실작업 | 35.6 : 1 |

턴 구성: `create`(143k) → `prepare`(145k) → 디스패치(147k) → `show`(151k) → acceptance + `inspect-claude`(152k) → `report`(159k). 오버헤드는 작업 크기가 아니라 오케스트레이터의 컨텍스트 크기에 비례한다.

디스패치 턴의 출력 3,230 토큰이 전체 중 최대였다. `prepare` 결과를 그대로 재전송하라는 규칙 때문에 CLI가 이미 만든 프롬프트를 모델이 손으로 다시 타이핑한다. 그 전사 중 Windows 경로의 백슬래시 이스케이프로 1턴을 추가 소모했다.

### 1.4 위임의 가치

`[세션]` 메인 세션 턴과 워커 턴을 `isSidechain` 및 `subagents/agent-*.jsonl` 179개로 분리 집계:

| 모델 | 메인 턴당 컨텍스트 | 워커 턴당 컨텍스트 | 턴당 절감 |
|---|---:|---:|---:|
| sonnet-5 | 439,784 | 153,695 | 286,089 |
| opus-5 | 338,022 | 177,907 | 160,115 |
| haiku-4.5 | 125,724 | 54,370 | 71,354 |

같은 모델이라도 워커로 돌면 컨텍스트가 1/3이다. 토큰 절감의 지렛대는 "더 싼 모델"이 아니라 "더 많은 위임"이며, 현재 설계는 그 위임을 차단한다.

---

## 2. 설계 원칙

`[레포]` 훅은 0턴에 일한다. 파일럿의 원장 이벤트 `reserved → bound → stop-observed` 는 오케스트레이터의 개입 없이 기록됐다. 반면 오케스트레이터는 훅이 이미 아는 사실을 CLI로 되묻느라 턴당 150k~800k를 쓴다.

> **강제 장치와 그 조작자가 같은 컨텍스트에 있으면 안 된다.**

오케스트레이터를 프로토콜에서 기반층으로 옮긴다. subagent-driven-development 가 워크플로를 주도하고, 오케스트레이터는 그 아래에서 계획된 작업만 강제한다.

### 2.1 런타임 동등성에 대한 정정

`[레포]` 두 런타임은 **이미 동등하지 않다.** `scripts/build.cjs:26-41` 이 생성하는 등록 이벤트가 다르다:

```
codex  : UserPromptSubmit, SubagentStart, PreToolUse, PostToolUse          (4)
claude : + PostToolUseFailure, SubagentStop                                 (6)
```

따라서 "완전 동등"은 **같은 이벤트 집합**이 아니라 **같은 보장**으로 정의한다: *계획된 디스패치는 검증되고, 계획되지 않은 디스패치는 방해받지 않는다.* 각 런타임은 자기 이벤트 집합 안에서 그것을 구현한다.

---

## 3. Phase 1 — 차단 해제

Phase 1의 범위는 경계 걷기가 만든 분기 표에서 나왔다. 관찰 기록은 Phase 2로 미룬다(§4.1).

### 3.1 마커 판정

`[레포]` 오늘 마커를 판정하는 술어가 셋이고 서로 다르다:

| 위치 | 정규식 |
|---|---|
| `src/claude-hook.cjs:7` | `/^ORCH_TASK /` |
| `src/hook.cjs:18` | `/^ORCH_TASK [a-f0-9-]{36} /` |
| `src/engine.cjs:122` | `/^ORCH_TASK ([a-f0-9-]{36}) ([a-zA-Z0-9_-]{1,64})(?:\r?\n|$)/` |

**`engine.cjs:122` 를 유일한 기준으로 삼는다.** run id와 step id를 모두 요구하는 가장 엄격한 형태이고, 실제로 예약을 찾는 데 쓰이는 것이기 때문이다.

`src/engine.cjs:120-121` 이 정하는 대로 `input.message` → `input.prompt` → `items[].text` 순으로 본다. 이는 이미 구현돼 있다.

`parseTask` 는 throw하므로(`engine.cjs:123`) 술어로 직접 쓸 수 없다. **`hasTask(input)` 을 `engine.cjs` 에 추가**해 boolean을 반환하게 하고, `parseTask` 는 그것을 호출한 뒤 throw하도록 재구성한다. 두 훅은 `hasTask` 만 쓴다.

Codex 훅은 `src/hook.cjs:28` 의 `object(event.tool_input)` 를 **마커 판정 전에** 적용해야 한다. `tool_input` 이 JSON 문자열로 도착할 수 있다.

### 3.2 게이트 위치 — 분리

**결정:** 재귀 가드는 모든 디스패치에 유지하고, 프로필 검사만 마커 있는 디스패치에 한정한다.

```js
if(type==='PreToolUse'){
  if(event.agent_id)throw new Error('Worker cannot recursively delegate');  // :16 유지, 모든 디스패치
  if(!e.hasTask(event.tool_input))return {};                                // ← 새 게이트
  a.checkProfile(event.tool_input,event.cwd);db=e.openDb();                 // 마커 있을 때만
  e.reserve(db,event.tool_input,event.session_id,event.tool_use_id,'claude');
}
```

근거: `checkProfile` 은 **orch 프로필의 무결성**을 검사한다(`claude-adapter.cjs:20` 알 수 없는 프로필, `:23` 변조, `:27` 프로젝트 오버라이드, `:31` 강제 모델). `general-purpose` 에 적용하는 것은 범주 오류다. 재귀 금지는 성격이 다른 안전 속성이고 subagent-driven-development 도 같은 규칙을 갖는다.

**부작용을 명시한다:** 마커 없는 디스패치에 대해 `claude-adapter.cjs:23`(프로필 변조)·`:27`(프로젝트 오버라이드)·`:31`(`CLAUDE_CODE_SUBAGENT_MODEL_FORCE`) 검사가 더 이상 적용되지 않는다. 이 셋은 orch 프로필을 쓰는 디스패치에만 의미가 있으므로 손실이 아니다.

Codex는 `src/hook.cjs:29-30` 앞에 같은 게이트를 넣는다. 재귀 가드는 Codex 훅에 존재하지 않으므로 Phase 1에서 추가하지 않는다(§8 결정 4).

### 3.3 PostToolUse

`[레포]` `src/claude-hook.cjs:26` 과 `src/hook.cjs:34` 는 `parseTask` 를 무조건 호출해 마커 없는 입력에 대해 `systemMessage` 를 뿜는다.

변경 후에는 계획 없는 디스패치가 **성공**하므로 PostToolUse가 확실히 발화한다. 따라서 같은 게이트를 넣는다: 마커가 없으면 `{}` 를 반환한다. 이를 빠뜨리면 모든 계획 외 디스패치가 컨트롤러 컨텍스트에 재조정 메시지를 주입한다.

### 3.4 PostToolUseFailure (Claude 전용)

`[레포]` `src/claude-hook.cjs:31-32` 는 마커 검사도 원장 접근도 없이 무조건 throw한다. 모든 실패한 Agent/Task 호출이 재조정 메시지를 낳는다.

마커 없는 입력에 대해 `{}` 를 반환하도록 게이팅한다. Codex는 이 이벤트를 등록하지 않으므로 해당 없다.

### 3.5 SubagentStart

**Claude:** `hooks.json` 의 matcher가 `^native-agent-orchestrator:orch-` 이므로 계획 외 워커에는 애초에 발화하지 않는다. 변경 없음.

`[세션+레포]` matcher가 `agent_type` 에 매칭된다는 것은 파일럿으로 확인됐다 — run `10025e0a` 의 이벤트에 `stop-observed` 가 있고, 그것은 `SubagentStop` 훅에서만 생성되며(`engine.cjs:218`), `SubagentStop` 이벤트에는 `tool_name` 이 없다.

**Codex:** `src/hook.cjs:18` 의 `const isWorker=type==='SubagentStart'||…` 때문에 **모든** Codex 서브에이전트가 "너는 스코프된 워커다, 계획을 만들거나 자식을 띄우지 마라" 지침을 받는다. 등록도 matcher 없이 되어 있다(`plugins/…/hooks/hooks.json:17-19`).

**결정:** 계획된 워커에만 주입한다. Codex `SubagentStart` 이벤트가 예약을 특정할 수단을 싣는지는 미확인이므로(§6.2), Phase 1에서는 **보수적으로** 처리한다: 이벤트가 예약과 상관 가능한 식별자를 싣지 않으면 주입하지 않는다. 계획된 Codex 워커는 `prepare` 가 만든 `message` 안에 이미 전체 과제와 워커 지침을 갖고 있으므로 주입 없이도 동작한다(`engine.cjs:111`).

### 3.6 정책 텍스트

`[레포]` `src/coordinator.md:10` 은 "Do not bypass a denied dispatch by changing tools" 라고 지시한다. 변경 후 존재하지 않는 동작을 기술하게 되므로 수정한다.

**제약:** 다음 문장들은 테스트가 고정하므로 유지해야 한다.

| 테스트 | 요구 |
|---|---|
| `src/test/hooks.test.cjs:24` | `coordinator.md` 에 `/simple questions\|status/i` |
| `src/test/hooks.test.cjs:25` | `coordinator.md` 에 `/parent/` |
| `src/test/claude.test.cjs:85` | `claude-coordinator.md` 에 `/simple questions\|status/i` |
| `test/distribution.test.cjs:33` | 주입 텍스트에 `scripts/cli.cjs` 절대경로 포함 |

`[레포]` Codex 주입에는 상한이 있다: `plugins/…/hooks/hooks.json:12` 가 `additionalContextLimit: 8000`, `:25` 가 `1000`. 현재 페이로드는 5,840자와 378자다.

정책 축약은 위 4개 제약을 지키는 선에서만 한다. **활성 run 알림 한 줄 추가는 Phase 2로 미룬다** — 관찰 기록과 함께 설계해야 의미가 있다.

---

## 4. Phase 2 — 연기

### 4.1 관찰 모드

계획 외 디스패치를 원장에 기록하는 기능. 경계 걷기가 두 개의 미해결을 드러냈으므로 Phase 1에 넣지 않는다.

- **조인 키:** `agent_id` 는 SubagentStart/Stop에, `tool_use_id` 는 PreToolUse/PostToolUse에 온다. 계획 모드는 예약된 프로필 슬롯으로 잇지만(`engine.cjs:147`, `claude-adapter.cjs:34`), 임의 `subagent_type` 에는 슬롯이 없다. PostToolUse가 둘 다 갖고 있어 해결 가능해 보이나 설계가 필요하다.
- **matcher 확대:** 계획 외 워커의 정지 데이터를 얻으려면 `hooks.json` 의 SubagentStart/Stop matcher를 넓혀야 한다. 5초 훅 예산 안에서 트랜스크립트를 읽는 비용이 값이 매겨지지 않았다.

### 4.2 계획서를 먹는 계획 모드

`create` 가 `docs/superpowers/plans/*.md` 를 직접 읽어 스텝을 유도한다. 스텝은 텍스트를 복사하지 않고 `{plan_file, task_number, section_sha}` 로 참조하며, 워커 페이로드는 디스패치 시점에 추출한다. 사이드카 `<plan-basename>.orch.json` 이 `model`·`reasoning_effort`·`reason`·`acceptance`(필수)와 `read_paths`·`write_paths`(선택, 기본 `["**"]`)를 공급한다.

### 4.3 프로토콜 붕괴 6턴 → 3턴

`prepare` 왕복 제거, 페이로드 전사 제거, `show` 예외 강등, `inspect-claude` 를 `report` 내부로. 목표는 스텝당 897,754 → 약 450,000 토큰.

`[레포]` `report` 의 계약 변경을 동반한다 — 현재 `observed_model` 을 호출자에게 요구하고(`engine.cjs:169`), `claude-adapter.inspect()` 는 트랜스크립트가 없으면 throw한다(`:54`).

### 4.4 런타임 어댑터 인터페이스

`[레포]` `engine.cjs` 의 런타임 분기를 어댑터로 추출한다. 분기 지점: `:11-12`, `:52`, `:62`, `:113`, `:126-147`, `:167-174`, `:195`, `:214`.

**엔진과 원장은 쪼개지 않는다.** `src/test/claude.test.cjs:90` 이 Codex 쓰기 예약이 Claude 읽기 스텝을 차단함을 검증하고, `src/test/packaging.test.cjs:14` 가 두 설치본의 단일 원장 공유를 검증한다.

---

## 5. 테스트

### 5.1 기준선 — 실측

```
npm run check:build   →  Distribution matches source.
node --test src/test/*.test.cjs test/*.test.cjs
                      →  tests 44 · pass 43 · fail 0 · skipped 1
```

`[레포]` 유일한 skip은 `src/test/permissions.test.cjs:8` 로 win32에서 건너뛴다. 파일별 개수: `engine` 15, `claude` 9, `hooks` 7, `lifecycle-regression` 8, `packaging` 2, `permissions` 1, `distribution` 2.

### 5.2 합격 게이트

`[레포]` `package.json:9` 의 `"pretest": "node scripts/build.cjs"` 가 `npm test` 실행 시 `plugins/`·`claude-plugins/` 를 재생성한다. 그리고 `test/distribution.test.cjs:14` 는 **생성된 사본**을 로드한다. 따라서 `src/` 만 고치고 `node --test` 를 돌리면 배포 테스트가 낡은 코드를 검사하며 초록이다.

**게이트는 `npm test` 다** (pretest 재생성 포함). CI에서는 `npm run check:build` 로 커밋된 배포본이 소스와 일치하는지 별도 검증한다.

### 5.3 바뀌는 테스트 — 정확히 이것들

초판의 "기존 테스트가 한 줄도 바뀌지 않고 통과한다"는 **거짓이었다.** Phase 1은 의도된 동작 변경이므로 다음 테스트가 바뀐다.

| 파일:줄 | 테스트 | 처리 |
|---|---|---|
| `src/test/hooks.test.cjs:30` | `unrelated tool is inert; missing model denies without starting work` | **분할한다.** `:32` 의 "unrelated tool is inert" 단언은 유지. `:33-34` 의 deny 단언은 `assert.deepEqual(hook(...),{})` 로 반전. `:35` 의 `attempts===0` 은 그대로 유효하다. 테스트 이름도 동작에 맞게 바꾼다 |

그 외 43개는 변경 없이 통과한다. 근거: 나머지 모든 훅 호출 테스트는 `e.prepare()` 산출물을 입력으로 쓰므로 마커를 갖고 있고, 새 게이트를 통과해 기존 경로로 들어간다.

`src/test/claude.test.cjs:71`(재귀 가드)과 `:73`(프로필 변조)은 §3.2의 분리 결정 덕분에 **의미까지 보존된다** — 재귀 가드가 게이트보다 앞에 남기 때문이다.

### 5.4 새로 쓸 테스트

| # | 테스트 | 검증 대상 |
|---|---|---|
| 1 | Claude: `subagent_type:'general-purpose'`, 마커 없음 → 훅이 `{}` | §3.2. **오늘 이 동작을 고정하는 테스트가 하나도 없다** |
| 2 | Codex: `spawn_agent`, 마커 없음 → `{}` | §3.2 Codex 측 |
| 3 | 마커 없는 PostToolUse → `{}` (양 런타임) | §3.3 |
| 4 | 마커 없는 PostToolUseFailure → `{}` | §3.4 |
| 5 | 워커 내부(`agent_id` 존재) 마커 없는 디스패치 → 여전히 deny | §3.2 재귀 가드 보존 |
| 6 | 마커 있는 디스패치의 프로필 변조 → 여전히 deny | §3.2 프로필 검사 보존 |
| 7 | `hasTask()` 가 세 가지 입력 형태(`message`/`prompt`/`items[]`)에서 일관 | §3.1 |

### 5.5 토큰·턴 회귀 — 수동

`[세션]` 베이스라인이 원장에 보존돼 있다: run `10025e0a` (6턴 / 897,754 / 디스패치 출력 3,230). Phase 2 목표는 3턴 / 약 450,000 / 약 150. 재현 절차는 동일한 읽기 전용 1스텝 계획을 실행하고 트랜스크립트에서 `message.id` 로 중복 제거한 어시스턴트 턴의 컨텍스트 합을 구하는 것이다.

---

## 6. 성공 기준

### 6.1 위임 성공률

`[세션]` 설치 후 27회 시도 중 14회 성공(51.9%). 실패 13회 중 일부는 훅 거부이고 일부는 `InputValidationError` 다. **이 설계는 훅 거부만 제거한다.**

따라서 기준은 성공률 백분율이 아니라 **동작 단언**으로 둔다: §5.4의 테스트 1~4가 통과하면 훅은 더 이상 계획 외 위임을 막지 않는다. 그 외의 실패 원인은 이 설계의 범위 밖이다.

### 6.2 미확인으로 남는 것

- Codex `SubagentStart` 이벤트가 예약을 특정할 식별자를 싣는지. §3.5는 이를 모른다는 전제에서 보수적으로 설계했다.
- 다른 플러그인이 같은 이벤트에 훅을 등록했을 때의 합성 동작. `src/claude-hook.cjs:24` 의 주석이 이것이 문제됨을 시사하지만 저장소에 검증이 없다.

---

## 7. 마이그레이션

| 항목 | 처리 |
|---|---|
| 버전 | `plugins/native-agent-orchestrator/.codex-plugin/plugin.json` 과 `claude-plugins/native-agent-orchestrator/.claude-plugin/plugin.json` **둘 다** 0.2.0, `package.json` 도 함께 |
| 배포본 | `npm run build` 로 재생성, `npm run check:build` 로 일치 확인 |
| 원장 | 스키마 변경 없음. Phase 1은 테이블을 추가하지 않는다 |
| 적용 | 실제로 실행되는 것은 `cache/…/0.1.0/` 이다. 커밋 후 **플러그인 업데이트가 필요**하다 |
| 되돌리기 | git revert + 플러그인 재설치. 원장에 흔적이 남지 않는다 |

---

## 8. 결정

**결정 1 — 계획 외 위임을 막지 않는다.**
`[세션]` 실제 워크플로가 brainstorming → writing-plans → subagent-driven 이고, 충돌은 항상 세 번째 단계에서 발생하며 매번 오케스트레이터가 배제됐다.
*틀렸을 때 비용:* 모든 위임이 원장을 거치게 하려던 원래 목표를 포기한다. 감사가 필요한 작업은 계획 모드를 명시적으로 선택해야 한다.

**결정 2 — 재귀 가드는 유지하고 프로필 검사만 한정한다.**
`checkProfile` 은 orch 프로필의 무결성을 검사하므로 임의 `subagent_type` 에 적용하는 것은 범주 오류다. 재귀 금지는 다른 안전 속성이다.
*틀렸을 때 비용:* 마커 없는 디스패치에 대해 프로필 변조·프로젝트 오버라이드·강제 모델 검사가 적용되지 않는다.

**결정 3 — `engine.cjs:122` 의 정규식을 유일한 마커 기준으로 삼는다.**
세 술어가 달랐고, 예약을 실제로 찾는 것이 그것이다.
*틀렸을 때 비용:* 느슨한 형태(`ORCH_TASK` 만 있는 프롬프트)가 계획 외로 분류된다. 그런 입력은 오늘도 `reserve` 에서 거부되므로 실질 변화는 없다.

**결정 4 — Codex에 재귀 가드를 추가하지 않는다.**
`src/hook.cjs` 에는 `event.agent_id` 를 읽는 코드가 없고, Codex 이벤트가 그것을 싣는지 확인되지 않았다. 확인 없이 추가하면 검증할 수 없는 동작이 생긴다.
*틀렸을 때 비용:* Codex 워커의 재귀 위임이 막히지 않는다. Phase 2의 스파이크 대상이다.

**결정 5 — 합격 기준을 "정확히 이 테스트가 바뀐다"로 둔다.**
초판의 "한 줄도 바뀌지 않는다"는 거짓이었다. Phase 1은 의도된 동작 변경이므로, 정직한 기준은 어떤 테스트가 왜 바뀌는지를 미리 적는 것이다.
*틀렸을 때 비용:* 없음. 이 기준이 더 엄격하다.

**결정 6 — 관찰 모드를 Phase 2로 미룬다.**
조인 키와 matcher 확대 비용이 해결되지 않았다.
*틀렸을 때 비용:* Phase 1 후에도 계획 외 디스패치는 원장에 남지 않는다. 오늘과 같다.

---

## 9. 이 설계가 다루지 않는 것

- `InputValidationError` 로 실패하는 디스패치 (§6.1).
- subagent-driven-development 스킬 자체의 수정. 공식 플러그인 캐시에 있어 업데이트 시 덮어쓰인다.
- orch 프로필의 `disallowedTools: Agent, SendMessage` (`claude-adapter.cjs:12`). 훅과 독립된 두 번째 방어층이며 그대로 둔다.
- 다른 플러그인 훅과의 합성 동작 (§6.2).
- Codex 런타임에서 subagent-driven-development 에 해당하는 워크플로. 이 머신에 실행 기록이 없다.
