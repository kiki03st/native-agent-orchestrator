# 오케스트레이터를 기반층으로 — 설계

**날짜:** 2026-09-20
**대상:** `native-agent-orchestrator` 0.1.0 → 0.2.0
**작성 근거:** 이 머신의 전체 세션 실측 (트랜스크립트 52개 디렉터리, 어시스턴트 16,629턴, 컨텍스트 46.8억 토큰) 및 통제된 파일럿 run 1회

---

## 1. 문제

오케스트레이터는 두 가지를 동시에 하려다 둘 다 실패하고 있다. **강제 장치**(어떤 모델이 무엇을 했는지 증명)이면서 동시에 **모델이 손으로 실행하는 프로토콜**이다. 후자가 전자를 무력화한다.

### 1.1 P0 — 훅이 모든 비-오케스트레이션 위임을 거부한다

`claude-hook.cjs:15-18`은 PreToolUse에서 `checkProfile()`을 무조건 호출하고, `subagent_type`이 `native-agent-orchestrator:`로 시작하지 않으면 예외를 던진다. `claude-hook.cjs:36`이 그 예외를 `permissionDecision: 'deny'`로 바꾼다. Codex 쪽도 같다 — `hook.cjs:30`이 `reserve()`를 무조건 호출하고 `parseTask()`가 마커 없는 입력에 대해 throw 한다.

결과: **계획에 등록되지 않은 모든 위임이 차단된다.** `Explore`, `general-purpose`, 플러그인 에이전트, 그리고 subagent-driven-development 의 구현자까지 전부.

측정된 영향 — 플러그인 설치일 2026-09-14 기준 자연 실험:

| | 디스패치 시도 | 생성된 워커 | 성공률 | 거부 |
|---|---:|---:|---:|---:|
| 설치 전 | 119 | 118 | **99.2%** | 0 |
| 설치 후 | 27 | 14 | **51.9%** | 27 |

subagent-driven-development 를 실제로 사용한 유일한 프로젝트(lolchess)에서는 Agent 디스패치 10회가 **전부** 실패했다:

```
09-19 09:09  general-purpose            PreToolUse:Agent hook error: Claude orchestration:
                                        Expected plugin-qualified Claude worker profile
09-19 10:04  claude x3                  훅 거부 1 + InputValidationError 2
09-19 12:50  claude-haiku-4-5 / haiku   InputValidationError + 훅 거부
09-20 07:46  sonnet                     훅 거부
09-20 08:53  claude-sonnet-5 x2, opus   InputValidationError x2 + 훅 거부
```

컨트롤러는 이틀에 걸쳐 열 번 위임을 시도하고 열 번 차단당한 뒤, 12개 과제를 `Edit` 345회 / `Write` 171회로 직접 수행했다. 그 실행의 사후 분석은 계획서와 원장이 갈라져 Tasks 4·5·6·8·9·10·11 에 계약 위반이 발생했음을 기록한다.

**이것은 규율 실패가 아니라 구조적 봉쇄였다.**

### 1.2 P1 — 프로토콜 세금이 위임을 손해로 만든다

통제된 파일럿 (읽기 전용 1스텝, haiku/default, `src/policy.json`에서 값 3개 추출):

| 항목 | 실측 |
|---|---:|
| 프로토콜 필수 오케스트레이터 턴 | 6 |
| 그 6턴의 컨텍스트 토큰 | 897,754 |
| 그 6턴의 출력 토큰 | 10,433 |
| 워커 자체 비용 | 25,229 |
| **오버헤드 : 실작업** | **35.6 : 1** |

턴 구성: `create`(143k) → `prepare`(145k) → 디스패치(147k) → `show`(151k) → acceptance + `inspect-claude`(152k) → `report`(159k).

오버헤드는 작업 크기가 아니라 **오케스트레이터의 컨텍스트 크기에 비례**한다. 무거운 세션(중앙값 325,605) 기준 스텝당 1,953,630 토큰, p90(799,125) 기준 4,794,750 토큰.

부수 관측:

- 디스패치 턴의 출력 3,230 토큰이 전체 중 최대였다. `prepare` 결과를 그대로 재전송하라는 규칙 때문에 CLI가 이미 만든 프롬프트를 모델이 손으로 다시 타이핑한다.
- 그 전사 과정에서 Windows 경로의 백슬래시 이스케이프로 1턴을 추가 소모했다. 프롬프트에 JSON이 들어가는 한 재발하는 실패 유형이다.
- 파일럿 하나로 루트 컨텍스트가 143,497 → 163,714 (+20,217) 영구 증가했다.

### 1.3 위임의 실제 가치

메인 세션 턴과 워커 턴을 분리 집계한 결과 (`isSidechain` 및 `subagents/agent-*.jsonl` 179개 포함):

| 모델 | 메인 턴당 컨텍스트 | 워커 턴당 컨텍스트 | 턴당 절감 |
|---|---:|---:|---:|
| sonnet-5 | 439,784 | 153,695 | **286,089** |
| opus-5 | 338,022 | 177,907 | 160,115 |
| haiku-4.5 | 125,724 | 54,370 | 71,354 |

**같은 모델이라도 워커로 돌면 컨텍스트가 1/3이다.** 토큰 절감의 지렛대는 "더 싼 모델"이 아니라 "더 많은 위임"이며, 현재 설계는 그 위임을 차단하거나(P0) 위임 1회당 898k의 세금을 매긴다(P1). 파일럿의 898k는 sonnet 턴 하나를 위임해 얻는 286k 절감의 세 배다 — **현재 설계에서는 위임할수록 손해다.**

---

## 2. 설계 원칙

> **강제 장치와 그 조작자가 같은 컨텍스트에 있으면 안 된다.**

훅은 0턴에 정확하게 일한다. 파일럿에서 `reserved → bound → stop-observed` 가 오케스트레이터의 개입 없이 기록되는 것을 확인했다. 반면 오케스트레이터는 훅이 이미 아는 사실을 CLI로 되묻느라 턴당 150k~800k를 쓴다.

따라서 오케스트레이터를 **프로토콜에서 기반층으로** 재정의한다. subagent-driven-development 가 워크플로를 주도하고, 오케스트레이터는 그 아래에서 기록·검증한다.

### 2.1 3층 구조

| 층 | 무엇 | 어디서 | 턴 비용 |
|---|---|---|---|
| **강제층** | 계획 레코드, 예약·바인딩·정지 관측, 프로필 검사, 충돌 검사, 재디스패치 차단 | 훅 + SQLite | **0** |
| **판단층** | acceptance 판정, 리뷰 판결, 라우팅 결정 | 오케스트레이터 (모델) | 스텝당 1~2턴 |
| **작업층** | 구현·리뷰·검증 실행 | 워커 | 워커 자체 비용 |

### 2.2 두 가지 모드

| | **관찰 모드** (기본) | **계획 모드** (옵트인) |
|---|---|---|
| 진입 | 없음 | `create <plan.md>` |
| 디스패치 | 무엇이든 통과 | 계획을 주장하는 것은 검사 |
| 훅의 역할 | agent_id·모델·effort·시각·정지를 기록 | + 충돌 검사, acceptance 게이트, 모델 대조 |
| 컨트롤러 턴 | **0** | 3 (Phase 2 목표) |
| 거부 | **없음** | 계획 위반 시에만 |

**관찰 모드의 제1 규칙:** 디스패치가 `ORCH_TASK` 를 주장하지 않으면 훅은 어떤 이유로도 거부하지 않는다. DB가 잠겼든 손상됐든 프로필을 모르든, 기록을 포기하고 디스패치를 통과시킨다. 기록자가 기록 대상을 막을 수 없다.

---

## 3. Phase 1 — 차단 해제와 디스패치 기록

**이것이 지금 구현 가능한 범위다.** Phase 2는 §4로 분리한다.

### 3.1 훅 동작 변경

양 런타임 동일:

1. PreToolUse에서 디스패치 입력에 `ORCH_TASK <uuid> <step>` 마커가 있는지 **먼저** 확인한다. 마커는 기존 `parseTask()` 로 읽는다 — Claude의 `prompt` 와 Codex의 `message` 를 모두 처리하므로 런타임별 분기가 필요 없다.
2. 마커가 없으면 → 관찰 경로. 기록을 시도하고, 실패하든 성공하든 `{}` 를 반환한다. **`permissionDecision` 을 절대 반환하지 않는다.**
3. 마커가 있으면 → 기존 계획 모드 경로 그대로. 검증 실패 시 거부한다.

`checkProfile()` 은 계획 모드 경로에서만 호출된다.

### 3.2 워커 재귀

`claude-hook.cjs:16` 의 `Worker cannot recursively delegate` 는 다음과 같이 나뉜다:

- 관찰 모드: **기록하고 통과**시킨다. `nested: true` 로 표시한다.
- 계획 모드: 기존대로 거부한다. orch-* 프로필은 이미 `disallowedTools: Agent, SendMessage` 로 묶여 있어 이중 방어다.

### 3.3 `observations` 테이블

```
observations(
  call_id TEXT PRIMARY KEY,   -- PreToolUse tool_use_id
  session TEXT NOT NULL,
  data TEXT NOT NULL          -- JSON
)
```

기본키를 `call_id` 로 둔다. 툴 호출당 유일하므로 훅이 중복 발화해도 자연스럽게 멱등하며, 별도 중복 제거 로직이 필요 없다.

`data` 필드:

| 필드 | 출처 | 비고 |
|---|---|---|
| `call_id` | PreToolUse `tool_use_id` | |
| `agent_id` | PostToolUse 응답 / SubagentStart | |
| `subagent_type` | 디스패치 입력 | 임의 문자열 허용 (`Explore`, `caveman:*` 등) |
| `requested_model` | 디스패치 입력 | **생략 가능** — 그 경우 `null` |
| `observed_model` | 정지 시 트랜스크립트 파싱 | |
| `observed_effort` | SubagentStop `effort.level` | |
| `nested` | PreToolUse `agent_id` 존재 여부 | |
| `cwd`, `started_at`, `stopped_at` | 이벤트 | |

`requested_model` 이 `null` 인데 `observed_model` 이 채워지는 경우가 특히 중요하다. subagent-driven-development 자신이 *"모델을 생략하면 세션 모델을 상속해 이 절이 무력화된다"* 고 경고하지만 검증 수단이 없다. 이 기록이 그 수단이다.

### 3.4 관찰 기록은 게이팅에 참여하지 않는다

**이 제약을 놓치면 P0가 형태만 바꿔 재발한다.**

`engine.cjs:102-104` 의 `ready()` 는 모든 run의 활성 스텝을 세어 `policy.max_parallel`(3)로 제한한다. 관찰 기록이 `runs` 에 들어가면 SDD가 워커 3개를 띄운 순간 네 번째 디스패치가 전역 상한에 걸려 **거부된다**.

따라서 관찰 기록은 별도 테이블에 두고 `ready()`, `conflicts()`, 병렬 상한 **어디에도 참여하지 않는다**. 순수 기록이다.

부수적으로, 관찰 모드에서는 크로스 런타임 파일 충돌 탐지가 **불가능**하다 — 계획 없는 디스패치에는 `read_paths`/`write_paths` 정보가 없다. 이는 계획 모드 전용 기능으로 남는다.

### 3.5 읽기 경로 — 기록은 읽혀야 한다

관찰 기록에 읽기 경로가 없으면 쓰기 전용 데이터가 된다. 다음을 함께 구현한다:

- `list SESSION_ID` 가 run과 관찰을 함께 출력한다.
- `observations SESSION_ID` 가 관찰만, 모델 불일치를 강조해 출력한다 (`requested_model` 이 `null` 이거나 `observed_model` 과 다른 항목).

### 3.6 정책 주입 교체

현재 `claude-hook.cjs:8-9` 는 UserPromptSubmit마다 `claude-coordinator.md` 전문(5,506자 ≈ 1,449토큰)을 주입한다. 전수 측정 결과 121회 주입, 누적 약 175k 토큰 — 전체 컨텍스트 소비의 0.026%다. 토큰 자체는 미미하지만, 그 자리가 잘못 쓰이고 있다.

교체:

- **미종료 run 또는 관찰이 없을 때:** 단문 안내만. `create`, `list` 를 언급하는 3~4줄.
- **있을 때:** 한 줄을 덧붙인다.
  ```
  활성: run 10025e0a (pending 3, running 1), 관찰 2건 미종료. `list` 로 확인.
  ```
  미종료 관찰은 `stopped_at` 이 `null` 인 기록을 뜻한다.

`bind`/`fail`/`closed`/`retry` 재조정 절차는 **예외 섹션**으로 분리하고, 활성 run이 있을 때만 주입한다.

이 변경의 목적은 토큰 절감이 아니라 두 가지다. 첫째, 중단된 run을 가시화한다 (실측된 중단 2건의 원인은 원장이 갱신을 멈춘 뒤 아무도 그것을 몰랐다는 것이다). 둘째, 정책이 짧아야 옵트인 비용이 낮아진다.

### 3.7 Phase 1 완료 기준

- 위임 성공률 51.9% → **100%** (재현 테스트로 검증)
- 관찰 기록이 `list` 로 읽힌다
- 기존 테스트 6개 파일이 **한 줄도 바뀌지 않고** 통과한다

---

## 4. Phase 2 — 계획서를 먹는 계획 모드 (연기)

Phase 1 완료 후 착수한다. 설계 결정은 내려졌으나 선행 스파이크가 남아 있다.

### 4.1 `create` 가 계획서를 직접 읽는다

현재 계획 모드는 `docs/superpowers/plans/*.md` 로 이미 작성된 계획을 `plan.json` 으로 **재입력**하게 한다. 이 중복이 진입 비용의 대부분이며, 계획 본문이 두 번째 장소에 복사된다는 점에서 lolchess를 태운 드리프트와 같은 병이다.

계획서는 이미 기계가 읽을 수 있다. subagent-driven-development 의 `scripts/task-brief` 가 awk 6줄로 파싱한다:

```
!infence && /^#+[ \t]+Task[ \t]+[0-9]+/ { intask = ($0 ~ ("^#+[ \t]+Task[ \t]+" n "([^0-9]|$)")) }
```

실제 계획서 구조:

```
## Global Constraints
### Task 1: 쟁탈전 아이콘으로 phase = "carousel"
### Task 2: 재굴림 버튼 3개로 phase = "augment"
```

**스텝은 텍스트를 복사하지 않고 참조한다:** `{plan_file, task_number, section_sha}`. 워커 페이로드는 디스패치 시점에 계획서에서 추출한다. 사본이 없으므로 드리프트가 구조적으로 불가능하다. 실행 중 계획서가 변경되면 `section_sha` 불일치로 **경고**한다 (거부하지 않는다 — 계획 수정은 정당한 행위다).

### 4.2 사이드카가 부족한 필드를 공급한다

계획서에 개별 필드로 존재하지 않는 것: `model`, `reasoning_effort`, `read_paths`, `write_paths`, `acceptance`.

`<plan-basename>.orch.json` 이 과제별로 공급한다:

```
{ "1": { "model": "sonnet", "reasoning_effort": "high",
         "reason": "다중 파일 구현",
         "acceptance": ["11개 테스트 통과", "tsc 깨끗"],
         "write_paths": ["src/vision"] } }
```

`model`, `reasoning_effort`, `reason`, `acceptance` 는 **필수**다. `validatePlan` 이 이미 비어 있지 않은 acceptance를 요구하며(`engine.cjs:64`), 그 검증을 완화하지 않는다. 사이드카에 과제 항목이 없으면 `create` 는 실패하고 무엇이 빠졌는지 보고한다.

`read_paths`/`write_paths` 는 선택이며, 생략 시 기본값은 `["**"]` / `["**"]` 이다. 이는 모든 병렬 실행을 막는 안전한 기본값이며, subagent-driven-development 자신도 구현자의 병렬 디스패치를 금지한다. **계획 본문은 어떤 경우에도 재입력하지 않는다.**

### 4.3 프로토콜 붕괴 6턴 → 3턴

| 제거 대상 | 메커니즘 | 상태 |
|---|---|---|
| `prepare` 왕복 | `create` 가 스텝별 디스패치 인자를 함께 반환 | 슬롯 배정 미해결 — §6.2 |
| 페이로드 전사 | 프롬프트를 `ORCH_TASK <run> <step>` 로 축소, 훅이 워커에 과제 주입 | Claude 검증됨, Codex 미확정 — §6.1 |
| `show` 확인 | PreToolUse가 잘못된 디스패치를 거부하므로, 거부 없이 스폰되면 예약은 유효. 예외 경로로 강등 | 결정됨 |
| `inspect-claude` | `report` 내부에서 엔진이 `stop_observed.transcript_path` 를 직접 읽어 `observed_model` 을 채움 | 결정됨 |

목표: 스텝당 897,754 → 약 450,000 토큰. 디스패치 출력 3,230 → 약 150 토큰. 프롬프트에서 JSON이 사라지므로 백슬래시 이스케이프 실패 유형이 근절된다.

### 4.4 런타임 어댑터 인터페이스

`engine.cjs` 는 13곳에서 런타임으로 분기한다 (`11-12`, `52`, `113`, `126-147`, `167-174`, `195`, `214`). 이를 어댑터 인터페이스로 추출한다:

```
{ models, dispatchArgs(run, step, occupied), matchesDispatch(input, expected),
  workerPayload(event, run, step), verifyCompletion(step, result), observeStop(db, event) }
```

`engine.cjs` 에는 상태 머신·검증·충돌 탐지·원장만 남는다.

**엔진과 원장 자체는 쪼개지 않는다.** `claude.test.cjs:90-95` 는 Codex의 쓰기 예약이 Claude의 읽기 스텝을 차단하는 것을 검증하고, `packaging.test.cjs:14-30` 은 두 설치본이 하나의 원장을 공유함을 검증한다. 두 런타임을 모두 사용하는 한 이 보장이 필요하다.

동등성의 정의가 바뀐다: **"같은 메커니즘"이 아니라 "같은 인터페이스"**. 보장은 동일하되 각 런타임이 최선의 구현을 쓴다. 이로써 Codex 스파이크가 Claude 최적화를 막지 않는다.

### 4.5 Phase 2에서 제외하는 것

리뷰어 역할(`role: reviewer`), 기준별 판정(`criteria[]`), 수정 루프(`role: fixer`, `append` 명령), 자동 리뷰 게이트, 이탈 방지(활성 `write_paths` 편집 차단).

**제외 사유:** 이들의 근거로 삼았던 lolchess 데이터가 오염되어 있다. 그 프로젝트가 review-package diff를 0개 만든 것은 규율 부족이 아니라 디스패치 자체가 차단되었기 때문이다. Phase 1 이후 subagent-driven-development 가 정상 동작하는 상태에서 다시 관측해야 정당한 근거를 얻는다.

---

## 5. 오류 처리와 마이그레이션

### 5.1 관찰 모드가 감당해야 할 실패

| 상황 | 동작 |
|---|---|
| DB 잠김·손상·없음 | 기록 포기, 디스패치 통과. 훅 타임아웃 5초 안에 끝나도록 짧은 `busy_timeout` 사용 |
| 처음 보는 `subagent_type` | 문자열 그대로 기록 |
| `model` 생략 | `requested_model: null` 기록, 정지 시 `observed_model` 채움 |
| 정지 시 transcript 경로 없음 | 있는 것만 기록, 오류 없음 |
| 훅 프로세스 동시 실행 | `hooks.test.cjs:62-73` 이 이미 커버 |

### 5.2 마이그레이션 0.1.0 → 0.2.0

| 항목 | 처리 |
|---|---|
| 기존 원장 | `runs` 는 JSON blob이라 필드 추가만으로 호환. 구 row는 읽을 때 기본값 부여 |
| 새 테이블 | `CREATE TABLE IF NOT EXISTS observations` |
| 0.1.0 동작 보존 옵션 | 두지 않는다. 0.1.0 동작 자체가 결함이다 |
| 버전 | `plugin.json` 0.2.0, `npm run build` 로 양 패키지 재생성, `check:build` 로 커밋된 배포본 일치 확인 |
| **적용** | 실제로 실행되는 것은 `cache/.../0.1.0/` 이다. 레포 커밋 후 **플러그인 업데이트가 필요**하다 |
| 되돌리기 | git revert + 플러그인 재설치. `observations` 테이블만 남고 무해하다 |

---

## 6. 미해결 — 구현 전 결정 필요

### 6.1 Codex `SubagentStart` 이벤트 형태 (스파이크, 약 30분)

Claude는 검증된 경로가 있다. `claude.test.cjs:56-58` 이 증명한다 — SubagentStart가 `agent_type`(프로필 슬롯)을 실어오고 `claude-adapter.start()` 가 그 슬롯으로 열린 예약을 유일하게 특정한다.

Codex는 프로필이 없어 상관시킬 `worker_type` 이 없고, `hook.cjs:17-18` 은 SubagentStart를 단순히 `isWorker=true` 로만 취급한다. `hooks.test.cjs` 에 Codex SubagentStart 테스트가 없어 이 레포에 근거가 없다.

해결 후보:

- **(a)** Codex SubagentStart가 상관 가능한 ID를 실어온다 → Claude와 동일 방식
- **(b)** 워커 내부에서 UserPromptSubmit이 `ORCH_TASK` 프롬프트와 함께 발화한다 → 양 런타임 동일 코드. `hook.cjs:18` 과 `claude-hook.cjs:7` 이 이미 그 정규식을 갖고 있다
- **(c)** Codex만 장문 유지 (어댑터 인터페이스 안에서는 정당한 구현)

**Phase 2 착수 전 Codex 훅 이벤트를 덤프해 (a)/(b) 를 판별한다.**

### 6.2 슬롯 정적 배정의 건전성

`prepare()` (`engine.cjs:114`) 는 슬롯을 세션 내 모든 run의 **실시간 점유**로 배정한다. `create` 시점 정적 배정은 다른 run의 살아있는 워커와 충돌할 수 있다. 같은 (model, effort) 를 쓰는 run 두 개가 동시에 있으면 슬롯 3개가 고갈된다.

Phase 2 설계 시 해결한다. 후보: `create` 는 슬롯 없이 반환하고 훅이 디스패치 시점에 자유 슬롯을 바인딩한다.

---

## 7. 테스트

### 7.1 합격 기준

1. 기존 테스트 6개 파일이 **한 줄도 바뀌지 않고** 통과한다 — 동작 보존의 증거
2. P0 회귀 테스트가 0.1.0에서 실패하고 0.2.0에서 통과한다

### 7.2 Phase 1 신규 테스트

| # | 테스트 | 검증 대상 |
|---|---|---|
| 1 | `subagent_type: "general-purpose"`, ORCH_TASK 없음 → 훅이 `{}` 반환 | **P0. 핵심 테스트** |
| 2 | 같은 디스패치 후 SubagentStart/PostToolUse → `observations` 에 agent_id 기록 | 관찰 기록 |
| 3 | 계획 없는 디스패치 5개 동시 → 전부 통과 | 병렬 상한이 관찰 모드로 새지 않음 (§3.4) |
| 4 | DB 경로 쓰기 불가 → 디스패치 여전히 통과 | 기록자가 작업을 막지 않음 |
| 5 | `model` 생략 디스패치 → 정지 후 `observed_model` 채워짐 | 모델 구멍 탐지 |
| 6 | 중첩 디스패치(`event.agent_id` 존재, 마커 없음) → 통과하고 `nested: true` 기록 | §3.2 |
| 7 | 활성 run 없음 → 정책 주입에 예외 섹션 없음 | §3.6 |

### 7.3 토큰·턴 회귀 — 수동 절차

단위 테스트로 잡을 수 없다. 베이스라인이 원장에 보존되어 있다:

```
run 10025e0a-324a-4946-ab6b-1ee4d0170de9
베이스라인: 프로토콜 6턴 / 컨텍스트 897,754 / 디스패치 출력 3,230 / 인코딩 실패 1회
Phase 2 목표: 3턴 / 약 450,000 / 약 150 / 0회
```

재현 절차: 동일한 읽기 전용 1스텝 계획(haiku/default, `src/policy.json` 에서 값 3개 추출)을 실행하고, 세션 트랜스크립트에서 `message.id` 로 중복 제거한 어시스턴트 턴의 `cache_read_input_tokens + cache_creation_input_tokens + input_tokens` 합을 구한다.

---

## 8. 이 설계에서 내린 결정

**결정 1 — 관찰 모드를 기본값으로 한다.**
실제 워크플로가 brainstorming → writing-plans → subagent-driven 이고, 충돌은 항상 세 번째 단계에서 발생하며 매번 오케스트레이터가 배제되었다. 오케스트레이터가 매번 지는 경쟁을 계속시키는 것보다, 지지 않는 위치로 옮기는 편이 낫다.
*틀렸을 때 비용:* 강제력이 옵트인이 되어, 감사가 필요한 작업에 계획 모드를 명시적으로 선택해야 한다.

**결정 2 — 관찰 기록을 `runs` 가 아닌 별도 테이블에 둔다.**
`ready()` 의 전역 병렬 상한이 관찰 기록에 적용되면 P0가 재발한다.
*틀렸을 때 비용:* 관찰 기록에는 충돌 탐지가 적용되지 않는다. 계획 모드에서만 얻는 보장으로 남는다.

**결정 3 — 엔진과 원장은 런타임별로 쪼개지 않는다.**
크로스 런타임 파일 충돌 탐지(`claude.test.cjs:90-95`)와 단일 원장 공유(`packaging.test.cjs:14-30`)가 두 런타임을 모두 사용하는 전제에서 필요하다. 221줄 상태 머신을 두 벌로 복제하는 것은 원장이 계획서에서 떨어져 나가는 것과 같은 병이다.
*틀렸을 때 비용:* 어댑터 추출 리팩터가 필요하며, 두 런타임의 차이가 인터페이스 설계를 제약한다.

**결정 4 — 계획 모드는 계획 텍스트를 복사하지 않고 참조한다.**
`{plan_file, task_number, section_sha}` 로 저장하고 디스패치 시점에 추출한다.
*틀렸을 때 비용:* 계획서가 삭제되거나 이동하면 스텝이 해석 불가능해진다. `section_sha` 경고로 부분 완화된다.

**결정 5 — 리뷰어·수정 루프 기능을 Phase 2에서도 제외한다.**
근거로 삼았던 데이터가 P0에 오염되어 있다. 정상 동작하는 상태에서 재측정한 뒤 판단한다.
*틀렸을 때 비용:* 품질 게이트 도입이 늦어진다. subagent-driven-development 가 자체 리뷰 루프를 갖고 있으므로 공백은 아니다.

---

## 9. 이 설계가 다루지 않는 것

- subagent-driven-development 스킬 자체의 수정. 공식 플러그인 캐시에 있어 업데이트 시 덮어쓰인다.
- `writing-plans` 가 라우팅 정보를 내보내도록 하는 확장. 같은 이유로 사이드카 방식을 택했다.
- Codex 런타임에서 subagent-driven-development 에 해당하는 워크플로. 이 머신에 실행 기록이 없어 근거가 없다.
- 관찰 모드의 중복 디스패치 탐지. 작업 동일성 판정 기준이 정의되지 않았다.
