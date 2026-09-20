# 계획 외 위임 차단 해제 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 오케스트레이터 훅이 `ORCH_TASK` 마커를 갖지 않은 서브에이전트 디스패치를 더 이상 거부하거나 방해하지 않게 하고, 마커를 가진 디스패치에 대한 검증은 그대로 유지한다.

**Architecture:** `engine.cjs` 에 throw하지 않는 마커 술어 `hasTask()` 를 추가하고, 두 훅의 각 이벤트 분기 앞에 그것을 게이트로 넣는다. Claude 쪽 게이트는 재귀 가드 **뒤**, 프로필 검사 **앞**에 둔다. Codex 쪽은 `object()` 강제 변환 **뒤**, 원장 열기 **앞**에 둔다.

**Tech Stack:** Node.js >= 24 (CommonJS), `node:test`, `node:sqlite`. 외부 의존성 없음.

**Spec:** `docs/superpowers/specs/2026-09-20-orchestrator-as-substrate-design.md` (개정 2)

## Global Constraints

- **Node >= 24.** `package.json` 의 `"engines": { "node": ">=24" }`. `node:sqlite` 때문이다.
- **마커의 유일한 기준은 `src/engine.cjs` 의 정규식** `/^ORCH_TASK ([a-f0-9-]{36}) ([a-zA-Z0-9_-]{1,64})(?:\r?\n|$)/` 이다. `claude-hook.cjs:7` 과 `hook.cjs:18` 의 느슨한 정규식은 이 계획에서 **건드리지 않는다** (정책 주입 분기 전용이고 테스트가 고정한다).
- **재귀 가드는 모든 Claude 디스패치에 유지한다.** `claude-hook.cjs:16` 의 `if(event.agent_id)throw new Error('Worker cannot recursively delegate');` 는 게이트보다 앞에 남는다. Codex 훅에는 재귀 가드를 **추가하지 않는다**.
- **다음 문자열은 절대 제거하지 않는다.** 테스트가 고정한다.
  | 파일 | 유지해야 할 것 | 고정하는 테스트 |
  |---|---|---|
  | `src/coordinator.md` | `/simple questions\|status/i` 에 매칭되는 문장 | `src/test/hooks.test.cjs:24` |
  | `src/coordinator.md` | `parent` 라는 단어 | `src/test/hooks.test.cjs:25` |
  | `src/claude-coordinator.md` | `/simple questions\|status/i` 에 매칭되는 문장 | `src/test/claude.test.cjs:85` |
  | 두 훅의 UserPromptSubmit 주입 | `scripts/cli.cjs` 절대경로 접미사 | `test/distribution.test.cjs:33` |
- **Codex 주입 상한.** `plugins/native-agent-orchestrator/hooks/hooks.json` 의 `additionalContextLimit` 이 UserPromptSubmit 8000, SubagentStart 1000 이다. `coordinator.md` 를 8000자 이하로 유지한다 (현재 5,840자).
- **합격 게이트는 `npm test` 다.** `"pretest": "node scripts/build.cjs"` 가 `plugins/` 와 `claude-plugins/` 를 재생성한다. `node --test` 만 돌리면 `test/distribution.test.cjs` 가 낡은 배포본을 검사하며 초록이 된다.
- **모든 커밋은 재생성된 배포본을 포함한다.** `src/` 를 고친 뒤 `npm test` 를 돌리면 `plugins/` 와 `claude-plugins/` 가 갱신되므로, 셋을 함께 `git add` 한다. 그러지 않으면 `npm run check:build` 가 exit 1 로 실패한다.
- **기준선:** 변경 전 `npm test` 는 `tests 44 · pass 43 · fail 0 · skipped 1` 이다. 유일한 skip 은 win32 에서 건너뛰는 `src/test/permissions.test.cjs:8` 이다.

---

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `src/engine.cjs` | 계획 레코드·상태 머신·마커 파싱 | `hasTask()` 추가, `parseTask()` 가 그것을 사용, export 추가 |
| `src/claude-hook.cjs` | Claude 런타임 훅 디스패처 | PreToolUse·PostToolUse·PostToolUseFailure 에 게이트 삽입 |
| `src/hook.cjs` | Codex 런타임 훅 디스패처 | spawn 경로에 게이트 삽입, SubagentStart 무조건 주입 제거 |
| `src/coordinator.md` | Codex 정책 텍스트 | 거부 우회 금지 문장 교체 |
| `src/claude-coordinator.md` | Claude 정책 텍스트 | 계획 외 위임 허용을 반영 |
| `src/test/hooks.test.cjs` | Codex 훅 테스트 | `:30` 테스트 분할, 신규 통과 테스트 추가 |
| `src/test/claude.test.cjs` | Claude 훅 테스트 | 신규 통과 테스트 추가 |
| `package.json` | 버전 | 0.1.0 → 0.2.0 |
| `plugins/native-agent-orchestrator/.codex-plugin/plugin.json` | Codex 매니페스트 | 0.1.0 → 0.2.0 |
| `claude-plugins/native-agent-orchestrator/.claude-plugin/plugin.json` | Claude 매니페스트 | 0.1.0 → 0.2.0 |
| `plugins/**`, `claude-plugins/**` | 생성 배포본 | `npm run build` 산출물, 매 커밋에 포함 |

---

### Task 1: `hasTask()` — throw하지 않는 마커 술어

`parseTask()` 는 마커가 없으면 throw한다. 훅에서 술어로 쓸 수 없으므로 boolean 버전을 만들고, `parseTask` 가 그것을 재사용하게 한다. 동작은 바뀌지 않아야 한다 — 기존 테스트가 `parseTask` 의 throw를 고정한다.

**Files:**
- Modify: `src/engine.cjs:119-125` (`parseTask`), `src/engine.cjs:221` (exports)
- Test: `src/test/engine.test.cjs` (파일 끝에 추가)

**Interfaces:**
- Consumes: 없음
- Produces: `hasTask(input) -> boolean`. `input` 은 훅의 `tool_input` 객체. `input.message`, 없으면 `input.prompt`, 없으면 `input.items` 의 `type==='text'` 요소들을 개행으로 이어 붙인 문자열을 검사한다. Task 2·3·4·5 가 이것을 사용한다.

- [ ] **Step 1: Write the failing test**

`src/test/engine.test.cjs` 파일 맨 끝에 추가한다. **이 파일에는 모듈 스코프 `e` 가 없다** — `enginePath` 만 `:6` 에 있고 엔진은 `setup()` 안에서 require된다. 그래서 테스트 안에서 직접 require한다:

```js
test('hasTask recognizes the marker in every input shape without throwing',()=>{
  const e=require(enginePath);
  const id='00000000-0000-0000-0000-000000000000';
  assert.equal(e.hasTask({message:'ORCH_TASK '+id+' step\nbody'}),true);
  assert.equal(e.hasTask({prompt:'ORCH_TASK '+id+' step'}),true);
  assert.equal(e.hasTask({items:[{type:'text',text:'ORCH_TASK '+id+' step'}]}),true);
  assert.equal(e.hasTask({message:'unplanned'}),false);
  assert.equal(e.hasTask({message:'ORCH_TASK short id'}),false);
  assert.equal(e.hasTask({}),false);
  assert.equal(e.hasTask(undefined),false);
  assert.throws(()=>e.parseTask({message:'unplanned'}),/Missing plan marker/);
  assert.deepEqual(e.parseTask({message:'ORCH_TASK '+id+' step'}),{runId:id,stepId:'step'});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/test/engine.test.cjs`
Expected: FAIL with `TypeError: e.hasTask is not a function`

- [ ] **Step 3: Write minimal implementation**

`src/engine.cjs:119-125` 의 `parseTask` 전체를 다음으로 교체한다:

```js
const TASK_MARKER=/^ORCH_TASK ([a-f0-9-]{36}) ([a-zA-Z0-9_-]{1,64})(?:\r?\n|$)/;
function taskMessage(input) {
  let message=input?.message||input?.prompt;
  if(!message && Array.isArray(input?.items))message=input.items.filter(x=>x.type==='text').map(x=>x.text||'').join('\n');
  return message||'';
}
function hasTask(input) { return TASK_MARKER.test(taskMessage(input)); }
function parseTask(input) {
  const match=TASK_MARKER.exec(taskMessage(input));
  need(match,'Missing plan marker; create a plan and use cli.cjs prepare');
  return {runId:match[1],stepId:match[2]};
}
```

`src/engine.cjs:221` 의 exports 에 `hasTask` 를 넣는다:

```js
module.exports={openDb,createRun,getRun,listRuns,prepare,hasTask,parseTask,reserve,bind,report,markClosed,fail,retry,revise,observeClaudeStop};
```

- [ ] **Step 4: Run the full suite to verify nothing regressed**

Run: `npm test`
Expected: `tests 45 · pass 44 · fail 0 · skipped 1` — 기준선보다 1개 늘어난 것이 새 테스트다.

- [ ] **Step 5: Commit**

```bash
git add src/engine.cjs src/test/engine.test.cjs plugins claude-plugins
git commit -m "feat: add hasTask, a non-throwing marker predicate"
```

---

### Task 2: Claude PreToolUse 게이트

마커 없는 디스패치를 `checkProfile` 앞에서 통과시킨다. 재귀 가드는 게이트보다 앞에 남으므로 계속 모든 디스패치에 적용된다.

**Files:**
- Modify: `src/claude-hook.cjs:15-19`
- Test: `src/test/claude.test.cjs` (파일 끝에 추가)

**Interfaces:**
- Consumes: `e.hasTask(input)` (Task 1)
- Produces: 없음

- [ ] **Step 1: Write the failing test**

`src/test/claude.test.cjs` 파일 맨 끝에 추가한다. 이 파일의 `setup(t)` 헬퍼는 `:8` 에 정의되어 있고 `{db,run,step,dir,hook,profileDir}` 를 반환한다.

```js
test('Claude lets an unplanned dispatch through but still blocks recursion and profile tampering',t=>{
  const {db,run,hook,profileDir}=setup(t);
  assert.deepEqual(hook({hook_event_name:'PreToolUse',tool_name:'Agent',tool_use_id:'free',
    tool_input:{subagent_type:'general-purpose',prompt:'find the config loader'}}),{});
  assert.deepEqual(hook({hook_event_name:'PreToolUse',tool_name:'Task',tool_use_id:'free2',
    tool_input:{subagent_type:'Explore',description:'d',prompt:'unplanned'}}),{});
  assert.equal(e.getRun(db,run.id).steps[0].attempts,0);
  assert.equal(hook({hook_event_name:'PreToolUse',agent_id:'child',tool_name:'Agent',tool_use_id:'nested',
    tool_input:{subagent_type:'general-purpose',prompt:'unplanned'}}).hookSpecificOutput.permissionDecision,'deny');
  const input=e.prepare(db,run.id,'first');
  fs.appendFileSync(path.join(profileDir,input.subagent_type.split(':')[1]+'.md'),'Changed profile');
  assert.equal(hook({hook_event_name:'PreToolUse',tool_name:'Agent',tool_use_id:'call',tool_input:input})
    .hookSpecificOutput.permissionDecision,'deny');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/test/claude.test.cjs`
Expected: FAIL — 첫 단언에서 `{}` 대신 `permissionDecision:'deny'` 와 `Expected plugin-qualified Claude worker profile` 이 온다.

- [ ] **Step 3: Write minimal implementation**

`src/claude-hook.cjs:15-19` 를 다음으로 교체한다. 추가되는 것은 `hasTask` 한 줄뿐이고 위치가 중요하다:

```js
    if(type==='PreToolUse'){
      if(event.agent_id)throw new Error('Worker cannot recursively delegate');
      if(!e.hasTask(event.tool_input))return {};
      a.checkProfile(event.tool_input,event.cwd);db=e.openDb();
      e.reserve(db,event.tool_input,event.session_id,event.tool_use_id,'claude');
    }else if(type==='SubagentStart'){
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: `tests 46 · pass 45 · fail 0 · skipped 1`. `src/test/claude.test.cjs:69` (`Claude worker cannot recursively delegate and profile tampering blocks dispatch`) 가 **계속 통과해야 한다** — 통과하지 않으면 게이트를 재귀 가드보다 앞에 넣은 것이다.

- [ ] **Step 5: Commit**

```bash
git add src/claude-hook.cjs src/test/claude.test.cjs plugins claude-plugins
git commit -m "feat: let unplanned Claude dispatches through the PreToolUse hook"
```

---

### Task 3: Codex PreToolUse 게이트와 기존 테스트 분할

Codex 쪽 차단은 `reserve()` 안의 마커 검사다. 게이트를 `object()` 변환 뒤·원장 열기 앞에 넣는다. 그리고 **이 동작을 요구사항으로 고정하고 있는 기존 테스트를 분할한다.**

**Files:**
- Modify: `src/hook.cjs:26-31`
- Modify: `src/test/hooks.test.cjs:30-36`
- Test: `src/test/hooks.test.cjs` (분할 + 신규)

**Interfaces:**
- Consumes: `e.hasTask(input)` (Task 1)
- Produces: 없음

- [ ] **Step 1: 기존 테스트를 분할하고 새 단언을 쓴다**

`src/test/hooks.test.cjs:30-36` 의 테스트 전체를 다음 **두 개**로 교체한다. `:32` 의 "unrelated tool is inert" 단언은 그대로 보존되고, deny 단언만 반전된다:

```js
test('unrelated tool is inert',t=>{
  const {hook}=fixture(t);
  assert.deepEqual(hook({hook_event_name:'PreToolUse',tool_name:'exec_command',tool_input:{}}),{});
});
test('an unplanned spawn passes through without touching the plan',t=>{
  const {hook,run,db}=fixture(t);
  assert.deepEqual(hook({hook_event_name:'PreToolUse',tool_name:'spawn_agent',tool_input:{message:'unplanned'}}),{});
  assert.deepEqual(hook({hook_event_name:'PreToolUse',tool_name:'Agent',tool_use_id:'x',
    tool_input:JSON.stringify({message:'still unplanned'})}),{});
  assert.equal(e.getRun(db,run.id).steps[0].attempts,0);
});
```

두 번째 테스트의 두 번째 단언은 `tool_input` 이 **JSON 문자열**로 도착하는 Codex 경로를 덮는다. 게이트가 `object()` 변환보다 앞에 있으면 이 단언이 실패한다.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/test/hooks.test.cjs`
Expected: FAIL — `an unplanned spawn passes through…` 가 `{}` 대신 `permissionDecision:'deny'` 와 `Missing plan marker` 를 받는다.

- [ ] **Step 3: Write minimal implementation**

`src/hook.cjs:26-31` 을 다음으로 교체한다. 게이트가 `db=e.openDb()` 보다 앞에 있어 계획 외 디스패치는 원장 파일을 만들지도 않는다:

```js
  const e=require('./engine.cjs');let db;
  try{
    const input=object(event.tool_input);
    if(spawn&&!e.hasTask(input))return {};
    db=e.openDb();
    if(type==='PreToolUse'){
      e.reserve(db,input,event.session_id,event.tool_use_id);return {};
    }
```

게이트가 `spawn` 일 때만 적용되는 것이 중요하다. `close_agent` 는 마커가 아니라 `input.target` 으로 동작하므로 게이팅하면 안 된다.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: `tests 47 · pass 46 · fail 0 · skipped 1`. `src/test/hooks.test.cjs` 의 `spawn pre/post and close record lifecycle…`(`:37`)과 `closing a still-running worker…`(`:52`)가 계속 통과해야 한다 — close 경로를 게이팅하지 않았다는 증거다.

- [ ] **Step 5: Commit**

```bash
git add src/hook.cjs src/test/hooks.test.cjs plugins claude-plugins
git commit -m "feat: let unplanned Codex spawns through, split the test that pinned the denial"
```

---

### Task 4: PostToolUse 게이트 (양 런타임)

Task 2·3 이후 계획 외 디스패치는 **성공**한다. 따라서 PostToolUse 가 확실히 발화하고, `parseTask` 가 throw해 `systemMessage` 를 컨트롤러 컨텍스트에 주입한다. 같은 게이트로 막는다.

**Files:**
- Modify: `src/claude-hook.cjs:25`
- Test: `src/test/claude.test.cjs`, `src/test/hooks.test.cjs`

Codex 쪽은 Task 3 의 게이트가 `spawn` 경로 전체를 덮으므로 코드 변경이 필요 없다. 테스트로 그것을 고정한다.

**Interfaces:**
- Consumes: `e.hasTask(input)` (Task 1)
- Produces: 없음

- [ ] **Step 1: Write the failing test**

`src/test/claude.test.cjs` 끝에 추가한다:

```js
test('Claude PostToolUse stays silent for an unplanned dispatch',t=>{
  const {hook}=setup(t);
  assert.deepEqual(hook({hook_event_name:'PostToolUse',tool_name:'Agent',tool_use_id:'free',
    tool_input:{subagent_type:'general-purpose',prompt:'unplanned'},
    tool_response:{content:[{type:'text',text:'agentId: someagent'}]}}),{});
});
```

`src/test/hooks.test.cjs` 끝에 추가한다:

```js
test('Codex PostToolUse stays silent for an unplanned spawn',t=>{
  const {hook}=fixture(t);
  assert.deepEqual(hook({hook_event_name:'PostToolUse',tool_name:'spawn_agent',tool_use_id:'free',
    tool_input:{message:'unplanned'},tool_response:{agent_id:'native-free'}}),{});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/test/claude.test.cjs src/test/hooks.test.cjs`
Expected: Claude 쪽은 FAIL — `{"systemMessage":"Claude orchestration reconciliation required: Missing plan marker; …"}` 를 받는다. Codex 쪽은 **이미 PASS** 여야 한다 (Task 3 의 게이트가 덮는다). Codex 쪽이 실패하면 Task 3 의 게이트가 `spawn` 이 아니라 `type==='PreToolUse'` 에만 걸려 있는 것이다.

- [ ] **Step 3: Write minimal implementation**

`src/claude-hook.cjs:25-26` 을 다음으로 교체한다:

```js
    }else if(type==='PostToolUse'){
      if(!e.hasTask(event.tool_input))return {};
      const {runId,stepId}=e.parseTask(event.tool_input),id=a.agentId(event.tool_response);
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: `tests 49 · pass 48 · fail 0 · skipped 1`. `src/test/claude.test.cjs:60` (`Claude async spawn text binds by exact call ID`) 이 계속 통과해야 한다 — 마커 있는 입력이므로 게이트를 통과해 기존 경로로 들어간다.

- [ ] **Step 5: Commit**

```bash
git add src/claude-hook.cjs src/test/claude.test.cjs src/test/hooks.test.cjs plugins claude-plugins
git commit -m "feat: silence PostToolUse reconciliation for unplanned dispatches"
```

---

### Task 5: PostToolUseFailure 게이트 (Claude 전용)

`src/claude-hook.cjs:31-32` 는 마커 검사도 원장 접근도 없이 무조건 throw한다. 실패한 모든 Agent/Task 호출이 재조정 메시지를 낳는다. Codex 플러그인은 이 이벤트를 등록하지 않으므로 해당 없다.

**Files:**
- Modify: `src/claude-hook.cjs:31-32`
- Test: `src/test/claude.test.cjs`

**Interfaces:**
- Consumes: `e.hasTask(input)` (Task 1)
- Produces: 없음

- [ ] **Step 1: Write the failing test**

`src/test/claude.test.cjs` 끝에 추가한다. 두 번째 단언은 마커 있는 실패는 **여전히** 보고되어야 함을 고정한다:

```js
test('Claude PostToolUseFailure reports only for planned dispatches',t=>{
  const {db,run,hook}=setup(t);
  assert.deepEqual(hook({hook_event_name:'PostToolUseFailure',tool_name:'Agent',tool_use_id:'free',
    tool_input:{subagent_type:'general-purpose',prompt:'unplanned'}}),{});
  const input=e.prepare(db,run.id,'first');
  assert.match(hook({hook_event_name:'PostToolUseFailure',tool_name:'Agent',tool_use_id:'call',
    tool_input:input}).systemMessage,/Agent tool failed/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/test/claude.test.cjs`
Expected: FAIL — 첫 단언이 `{}` 대신 `{"systemMessage":"Claude orchestration reconciliation required: Agent tool failed; …"}` 를 받는다.

- [ ] **Step 3: Write minimal implementation**

`src/claude-hook.cjs:31-32` 를 다음으로 교체한다:

```js
    }else if(type==='PostToolUseFailure'){
      if(!e.hasTask(event.tool_input))return {};
      throw new Error('Agent tool failed; confirm whether any worker started before fail/closed reconciliation');
    }
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: `tests 50 · pass 49 · fail 0 · skipped 1`

- [ ] **Step 5: Commit**

```bash
git add src/claude-hook.cjs src/test/claude.test.cjs plugins claude-plugins
git commit -m "feat: gate PostToolUseFailure on the plan marker"
```

---

### Task 6: Codex SubagentStart 무조건 주입 제거

`src/hook.cjs:18` 의 `const isWorker=type==='SubagentStart'||…` 때문에 **모든** Codex 서브에이전트가 "너는 스코프된 워커다, 계획을 만들거나 자식을 띄우지 마라" 지침을 받는다. 계획 외 위임을 허용하면서 이 주입을 남겨두면 일반 에이전트가 잘못된 맥락을 받는다.

Codex `SubagentStart` 이벤트가 예약을 특정할 식별자를 싣는지 확인되지 않았으므로(스펙 §6.2), **보수적으로 주입하지 않는다.** 계획된 Codex 워커는 `engine.cjs:111` 이 만든 `message` 안에 동일한 워커 지침을 이미 갖고 있다.

**Files:**
- Modify: `src/hook.cjs:17`
- Test: `src/test/hooks.test.cjs`

**Interfaces:**
- Consumes: 없음
- Produces: 없음

- [ ] **Step 1: Write the failing test**

`src/test/hooks.test.cjs` 끝에 추가한다:

```js
test('Codex SubagentStart no longer injects worker text unconditionally',t=>{
  const {hook}=fixture(t);
  assert.deepEqual(hook({hook_event_name:'SubagentStart',agent_id:'any'}),{});
  const prompt=hook({hook_event_name:'UserPromptSubmit',prompt:'상태 알려줘'});
  assert.match(prompt.hookSpecificOutput.additionalContext,/simple questions|status/i);
  assert.match(prompt.hookSpecificOutput.additionalContext,/cli[.]cjs/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/test/hooks.test.cjs`
Expected: FAIL — 첫 단언이 `{}` 대신 `{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"You are a scoped worker, NOT the orchestrator. …"}}` 를 받는다.

- [ ] **Step 3: Write minimal implementation**

`src/hook.cjs:17-18` 을 다음으로 교체한다. `SubagentStart` 가 조건에서 빠지면 `:24` 의 게이트로 떨어져 `{}` 를 반환한다:

```js
  if(type==='UserPromptSubmit'){
    const isWorker=/^ORCH_TASK [a-f0-9-]{36} /.test(event.prompt||'');
```

`hooks.json` 의 `SubagentStart` 등록은 **건드리지 않는다.** `scripts/build.cjs:28` 이 생성하며, 제거하면 `test/distribution.test.cjs:23` 이 `config.hooks[event.hook_event_name]` 에서 undefined 를 만나 실패 대신 throw한다.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: `tests 51 · pass 50 · fail 0 · skipped 1`. `test/distribution.test.cjs` 의 두 테스트가 계속 통과해야 한다.

- [ ] **Step 5: Commit**

```bash
git add src/hook.cjs src/test/hooks.test.cjs plugins claude-plugins
git commit -m "feat: stop injecting worker text into every Codex subagent"
```

---

### Task 7: 정책 텍스트 갱신과 0.2.0 릴리스

정책 문서가 더 이상 존재하지 않는 동작을 지시한다. 세 곳의 버전을 올리고 배포본을 재생성한다.

**Files:**
- Modify: `src/coordinator.md` (10번 항목의 마지막 문장)
- Modify: `src/claude-coordinator.md` (2번째 문단)
- Modify: `package.json`, `plugins/native-agent-orchestrator/.codex-plugin/plugin.json`, `claude-plugins/native-agent-orchestrator/.claude-plugin/plugin.json`

**Interfaces:**
- Consumes: 없음
- Produces: 없음

- [ ] **Step 1: Codex 정책 문장 교체**

`src/coordinator.md` 의 10번 항목에서 다음 문장을 찾는다:

```
Do not bypass a denied dispatch by changing tools.
```

다음으로 교체한다:

```
Dispatches without an ORCH_TASK marker are not managed by this ledger and are not blocked; do not treat their success as orchestration.
```

**`/simple questions|status/i` 와 `parent` 를 포함하는 문장은 건드리지 않는다** (각각 2번 줄과 11번 항목).

- [ ] **Step 2: Claude 정책 문장 추가**

`src/claude-coordinator.md` 의 2번째 문단(`Use the available native Agent tool and installed orch-* worker profiles.` 로 시작하는 문단) 맨 끝에 다음 문장을 덧붙인다:

```
Dispatches without an ORCH_TASK marker bypass this ledger and are not blocked; use them freely for unmanaged work, and do not report them as orchestrated steps.
```

**1번 줄의 `Answer simple questions, explanations and status requests…` 문장은 건드리지 않는다.**

- [ ] **Step 3: 세 곳의 버전을 올린다**

```bash
node -e "for(const f of ['package.json','plugins/native-agent-orchestrator/.codex-plugin/plugin.json','claude-plugins/native-agent-orchestrator/.claude-plugin/plugin.json']){const fs=require('fs');fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace('\"version\": \"0.1.0\"','\"version\": \"0.2.0\"'));console.log('bumped '+f);}"
```

- [ ] **Step 4: 배포본 재생성과 전체 검증**

```bash
npm test
npm run check:build
```

Expected: `tests 51 · pass 50 · fail 0 · skipped 1`, 그리고 `Distribution matches source.`

`npm run check:build` 가 exit 1 로 `Distribution differs from source:` 를 출력하면, 이전 태스크 중 하나가 `plugins/` 또는 `claude-plugins/` 를 커밋에 포함하지 않은 것이다. `npm run build` 를 돌리고 생성된 파일을 함께 커밋한다.

- [ ] **Step 5: Commit**

```bash
git add src/coordinator.md src/claude-coordinator.md package.json plugins claude-plugins
git commit -m "feat: 0.2.0 — policy text reflects unmanaged dispatch passthrough"
```

---

## 수용 검증 (전체 완료 후)

- [ ] `npm test` → `tests 51 · pass 50 · fail 0 · skipped 1`
- [ ] `npm run check:build` → `Distribution matches source.`
- [ ] `git log --oneline 84b9518..HEAD` 이 7개 커밋을 보인다
- [ ] 스펙 §5.4 의 신규 테스트 7종이 모두 존재한다: Claude 통과(Task 2), Codex 통과(Task 3), PostToolUse 양쪽(Task 4), PostToolUseFailure(Task 5), 재귀 가드 보존(Task 2), 프로필 검사 보존(Task 2), `hasTask` 형태 일관성(Task 1)
- [ ] 플러그인을 업데이트해 `cache/.../0.2.0/` 이 설치된 뒤, 이 저장소 밖 아무 프로젝트에서 `Explore` 또는 `general-purpose` 서브에이전트를 띄워 거부되지 않는 것을 확인한다. **이것이 최종 검증이다** — 단위 테스트는 훅 함수만 검사하고 실제 하네스를 검사하지 않는다.

## 이 계획이 다루지 않는 것

- 관찰 기록(`observations` 테이블). 스펙 §4.1 로 연기됐다.
- 계획서를 직접 읽는 `create`. 스펙 §4.2.
- 프로토콜 6턴 → 3턴 감축. 스펙 §4.3.
- 런타임 어댑터 추출. 스펙 §4.4.
- `InputValidationError` 로 실패하는 디스패치. 스펙 §6.1.
- Codex 훅의 재귀 가드. 스펙 §8 결정 4 — Codex 이벤트가 `agent_id` 를 싣는지 미확인이다.
