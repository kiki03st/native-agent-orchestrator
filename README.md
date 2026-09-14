# Native Agent Orchestrator

Codex와 Claude Code에서 자연어 요청을 분석하고, 단계마다 모델을 명시한 네이티브 작업자를 실행하는 훅 플러그인입니다.

간단한 질문·설명·진행 확인은 현재 세션에서 답합니다. 실제 작업은 계획을 보여준 뒤 추가 승인 대기 없이 실행합니다. 단, 사용자가 허용한 범위와 호스트의 권한 승인은 그대로 유지됩니다.

## 동작

1. 현재 대화와 프로젝트 상태를 함께 분석합니다. 키워드 분류기가 아닙니다.
2. 단계·의존성·검증 기준·모델·추론 수준·선택 이유를 계획에 기록합니다.
3. 단계마다 새 네이티브 작업자를 만듭니다. 기본은 순차 실행이며 독립 작업만 최대 3개 병렬 실행합니다.
4. 원래 세션이 결과를 검증하고 실행 종료를 확인합니다. 검증·종료된 선행 단계만 후속 작업을 허용합니다.
5. 원래 세션에서 최종 결과를 보고합니다. 기록은 남기며, 중단 뒤에는 실제 작업자 상태와 대조합니다.

다른 제공자의 모델을 서로 호출하지 않습니다. Codex에서는 Codex 모델, Claude Code에서는 Claude 모델을 사용합니다. 모델별 자동 대체는 하지 않으며, 재시도는 단계당 최초 시도를 포함해 2회로 제한합니다.

## 요구 사항

- Node.js 24 이상 (`node`가 앱 실행 환경의 PATH에 있어야 합니다).
- 훅과 모델 지정 네이티브 하위 에이전트를 지원하는 Codex 또는 Claude Code.
- 선택한 모델을 사용할 수 있는 본인 계정. 별도의 API 키를 플러그인에 저장하지 않습니다.

개발 기준: Windows, Codex CLI 0.154.0, Claude Code 2.1.270. WSL Ubuntu 24.04에서도 테스트합니다. 배포판의 이벤트 재현 테스트는 실제 모델 호출 없이 실행됩니다. 모든 호스트 버전·계정에서의 실제 모델 실행을 보장하지 않습니다. 세 운영체제 검증은 저장소의 CI 작업으로 제공합니다.

## 설치

GitHub 저장소: [kiki03st/native-agent-orchestrator](https://github.com/kiki03st/native-agent-orchestrator). 비공개 저장소는 GitHub 접근 권한과 Git 인증이 필요합니다. 빌드 결과가 포함되어 있어 설치 전에 npm install이나 빌드는 필요하지 않습니다.

기존에 수동 설치한 같은 오케스트레이션 훅이 있다면 [이전 방법](docs/migration.md)을 먼저 확인하세요. 중복 활성화하면 안 됩니다.

### Codex

```sh
codex plugin marketplace add kiki03st/native-agent-orchestrator
codex plugin add native-agent-orchestrator@personal
```

저장소의 Codex marketplace 이름은 `personal`입니다. 이미 같은 이름의 다른 marketplace를 등록했다면 충돌을 먼저 해결해야 합니다. 설치 후 새 세션의 `/hooks`에서 `Native Agent Orchestrator:`로 시작하는 UserPromptSubmit, SubagentStart, PreToolUse, PostToolUse 항목 4개를 검토하고 신뢰 설정을 켭니다. 설치만으로 훅이 자동 신뢰되지는 않습니다. [Codex 공식 훅 문서](https://learn.chatgpt.com/docs/hooks)

### Claude Code

```sh
claude plugin marketplace add kiki03st/native-agent-orchestrator
claude plugin install native-agent-orchestrator@native-agent-orchestrator-marketplace
```

새 세션을 시작하고 `/plugin`, `/hooks`, `/agents`에서 로딩 상태를 확인합니다. 작업자 이름은 `native-agent-orchestrator:orch-sonnet-medium-one` 같은 형식이며 18개 프로필이 포함됩니다. 플러그인 훅은 사용자·프로젝트 훅과 함께 로딩됩니다. [Claude Code 공식 플러그인 문서](https://code.claude.com/docs/en/plugins-reference)

로컬에서 시험할 때는 저장소 루트에서 위 `marketplace add` 명령의 GitHub 주소 대신 `.`을 전달합니다. 기존 수동 훅이 활성화된 상태에서는 플러그인을 추가 활성화하지 마세요.

## 사용

설치·활성화 후 별도 명령어나 입력 형식 없이 평소처럼 요청합니다.

> 로그인 오류의 원인을 찾아 수정하고, 관련 테스트도 확인해줘.

> 중단됐던 작업의 상태를 확인하고 이어서 진행해줘.

> 지금 어디까지 했어?

마지막 요청 같은 상태 확인은 작업자를 만들지 않습니다. 이 플러그인은 대화 중 오케스트레이션을 지원하며 무인 백그라운드 스케줄러가 아닙니다.

## 데이터와 제한

계획·이벤트·검증 결과는 기본적으로 사용자 홈의 `.local/share/native-agent-orchestrator/state.sqlite`에 저장됩니다. 두 호스트가 같은 파일을 사용하므로 파일 범위 충돌을 함께 확인합니다. `ORCHESTRATOR_STATE_DIR`로 공통 데이터 폴더를 지정할 수 있고, `CODEX_ORCH_DB`는 DB 파일 경로를 직접 지정하는 우선 설정입니다. 두 호스트에 같은 절대 경로를 설정하세요.

플러그인 캐시 안에는 실행 기록을 쓰지 않습니다. 제거·업데이트 시 기록을 자동 삭제하지 않습니다. 플러그인 자체는 텔레메트리나 외부 API 요청을 보내지 않지만, 작업 프롬프트와 결과는 사용하는 호스트의 모델 처리 정책을 따릅니다. 계획 파일과 DB에 비밀정보를 넣지 마세요.

훅과 선언된 파일 범위는 작업 규칙·충돌 검사이지 보안 샌드박스가 아닙니다. 이 플러그인이 활성화된 세션에서는 관리되지 않는 Agent/spawn_agent 호출도 거부하므로, 별도 위임 체계를 쓰는 다른 플러그인과 충돌할 수 있습니다. 모델별 성능 순위나 속도 개선을 보장하지 않습니다. [모델 선택 기준](docs/model-routing.md)

## 개발

```sh
npm run build
npm test
npm run check:build
claude plugin validate claude-plugins/native-agent-orchestrator
claude plugin validate .claude-plugin/marketplace.json
```

외부 npm 의존성은 없습니다. `src/`가 공통 원본이며, `scripts/build.cjs`가 Codex와 Claude Code용 독립 배포 폴더를 생성합니다. 런타임은 `src/`를 수정한 뒤 빌드하세요. 각 플랫폼의 manifest와 루트 marketplace는 직접 관리합니다. `.github/workflows/test.yml`은 세 운영체제에서 테스트합니다.

Windows PowerShell에서 npm.ps1 실행 정책 오류가 나면 `npm` 대신 `npm.cmd`를 사용하세요. 실행 정책을 변경할 필요는 없습니다.

저장소에는 실행 DB, 사용자 설정, 인증 파일, 대화 기록을 포함하지 않습니다. 현재 별도 오픈소스 라이선스는 부여하지 않았습니다.
