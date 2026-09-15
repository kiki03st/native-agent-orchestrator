# 맥락 관리와 호스트 호환성 테스트

검증일: 2026-09-16. Codex 실제 훅 연결·암호화 메시지·완료 상태 호환성을 수정하고 의존 실행까지 검증했다.
합성 이벤트 테스트와 실제 모델을 호출하는 호스트 검증은 별도로 판정한다.

## 테스트 케이스와 판정

| ID | 시나리오 / 입력 | 기대 결과 | 검증 방법 | 결과 |
| --- | --- | --- | --- | --- |
| C01 | Codex legacy 계획, 추가 필드·fresh flag 누락 | 기존 계약 유지, 다른 인자 거부 | engine, codex-contracts | 통과 |
| C02 | collaboration 계획, 잘못된 task_name·fork_turns·반환 이름 | 정확한 인자만 예약, 같은 native identity만 바인딩 | codex-contracts | 통과 |
| C07 | collaborationspawn_agent·collaborationlist_agents 이름 | 예약·바인딩·완료 관측, closed=false 유지 | codex-contracts 및 배포 matcher 합성 이벤트 | 통과 |
| C08 | 명시적 encrypted 전송, 잘못된 모델·effort·task·시도·세션·fresh 인자·추가 키·빈 메시지 | 가시 인자 변조 거부, 메타데이터 검증 표시, 암호문 미저장; 평문 계획 자동 완화 금지 | codex-contracts 및 encrypted 배포 체인 | 통과 |
| C09 | tagged completed/errored 및 모호한 객체·잘못된 값 | 정확한 완료 관측만 기록, 부모 검증 전 의존 작업 차단 | codex-contracts 및 배포 체인 | 통과 |
| C03 | idle·interrupt·unknown·timeout 및 완료 관측만 수신 | 예약 유지, 후속 단계 차단 | codex-contracts | 통과 |
| C04 | 부모 검증 + 완료 증거 + 모델 근거 | collaboration은 execution_complete=true, closed=false로 후속 허용; legacy는 close 필요 | codex-contracts | 통과 |
| C05 | 실패·재시도 후 이전 agent/call의 지연 결과 | 새 시도는 fresh identity, 오래된 결과 거부 | lifecycle-regression, codex-contracts | 통과 |
| C06 | Claude profile·model·effort 변경, stop 관측만 수신 | 변조 거부, stop만으로 후속 실행 금지 | claude | 통과 |
| M01 | 빈 목록, 문자열 None, 한글 5,500자 | 동일한 상태로 왕복, 유효한 한글 기록을 크기 때문에 읽지 못하는 문제 없음 | memory | 통과 |
| M02 | 필드 누락·추가, 빈 문자열, 개행, null, 501자, 21개 항목, 전체 크기 초과, 절대 참조 경로 | 거부 후 기존 MD 바이트·revision·SQLite 기록 보존; 다음 정상 쓰기 가능 | memory 신규 케이스 | 통과 |
| M03 | 다른 부모·오래된 revision·동시 프로세스 쓰기 | 잘못된 소유자 거부, 동시 쓰기는 하나만 성공 | memory | 통과 |
| M04 | 다른 run 및 동일 run ID를 가진 복사 DB | 서로 다른 MD 파일, 상태 섞임 없음 | memory | 통과 |
| M05 | 새 CLI 프로세스로 기존 메모 읽기 | 상태·revision 유지, 파일·실행 기록 변경 없음 | memory 신규 케이스 | 통과 |
| D01 | 공백 경로로 옮긴 세 배포 경로에서 A → B | 배포 matcher와 명령으로 예약·바인딩, A 검증 전 B 차단, 완료 후 B 허용 | distribution 확장 케이스 | 통과 |
| D02 | 위 배포 경로에서 MD가 있는 작업 실행 | 프롬프트에는 경로만 포함, 실행 중 수정 거부, 완료 후 갱신 허용 | distribution 확장 케이스 | 통과 |
| I01 | 실제 설치본과 빌드 결과 비교, 설치 matcher로 합성 2단계 실행 | 파일 일치, Codex·Claude 체인 정상 | 비공개 로컬 설치 검증 스크립트 | 통과, 합성 검증 |
| I02 | Codex 두 사용자 범위 및 Claude 설정 검사 | Codex 각 4개 그룹, Claude 플러그인 활성·기존 수동 훅 0개 | 설정 읽기 검사 | 통과, 로딩·신뢰 증명은 아님 |
| P01 | Linux에서 permissive umask로 DB 생성 | 디렉터리·DB·WAL 사용자 전용 권한 | permissions, WSL Ubuntu 24.04 | 통과 |
| L01 | 실제 Codex native 호출 후 자동 예약·바인딩 | 수동 기록 없이 call/agent가 SQLite에 생성 | 활성 TUI 훅 재로딩 + 암호화 전송 명시 후 실제 A/B | 통과 |
| L02 | 실제 Codex 모델 확인 → 부모 검증 → B 실행 | 실제 모델 근거, A 검증 전 B 차단·검증 후 B MATCH | native thread/list, rollout, 부모 파일 대조와 원장 | 통과: 최종 A/B Luna/medium; 첫 A 범위 위반은 실패 기록 후 fresh 재시도 |
| L03 | 실제 Claude Agent A → B | profile 로딩, 자동 예약·바인딩, 실제 모델·완료 근거, B 실행 | Claude 네이티브 도구가 있는 새 세션 필요 | 사용자 요청으로 보류 |

## 실행 결과

- Windows / Node 24.18.0: `npm.cmd test` — **73 통과, 0 실패, 1 POSIX 검사 제외**.
- WSL Ubuntu 24.04 / Node 24.18.0: `node --test src/test/*.test.cjs test/*.test.cjs` — **74 통과, 0 실패, 0 제외**. Linux 파일시스템의 임시 복사본에서 실행했다.
- WSL 검증용 Node는 임시 디렉터리에서 사용했고 공식 배포본의 SHA-256 목록과 다운로드 파일을 대조했다. 시스템 Node 설정은 변경하지 않았다.
- `npm run check:build` 및 Linux `node scripts/build.cjs --check` — 배포본과 소스 일치.
- 실제 설치 파일·MD·합성 의존 체인 검증은 기존 변경에서 Codex·Claude 모두 통과. 이번 호환성 수정 후에는 Codex 설치본을 갱신하고 재검증했다.

## 실사용 검증 재개 절차

1. 호스트 세션에서 기존 작업을 대조하고 orchestrator 훅의 로딩·신뢰를 확인한다. 플러그인과 수동 훅을 중복 활성화하지 않는다.
활성 세션에 이전 matcher가 남아 있으면 `/hooks`에서 우리 훅만 껐다 켜 재로딩하고 실제 list_agents 이벤트를 확인한다. message 암호화가 확인된 collaboration 호스트는 새 계획에 encrypted 전송을 명시한다.

2. 해당 호스트에 노출된 모델·fresh context 인자를 확인하고, README 첫 제목을 읽는 A와 그 결과를 대조하는 B를 계획한다. B는 A에 의존하며 둘 다 쓰기 범위는 비워 둔다.
3. `prepare` 인자를 그대로 사용해 A를 생성한다. SQLite에 실제 예약 call ID와 반환 native ID가 자동 기록되지 않으면 그 호출 경로의 검증을 중단한다. 수동 reserve/bind로 자동 동작을 입증하지 않는다.
4. 요청 인자가 아닌 native 실행 메타데이터에서 모델을 확인하고, 완료 알림과 부모의 파일 대조 결과를 기록한다. idle·interrupt를 완료로 바꾸지 않는다.
5. A가 부모 검증과 호스트별 완료 조건을 모두 만족한 뒤에만 B를 실행한다. A/B의 실제 identity, call ID, 모델·완료 근거를 비공개 증거로 보관한다.

현재 자동 테스트와 Codex L01/L02 실제 검증은 통과했다. L03은 사용자 요청으로 보류했다. 외부 CLI/API 작업자로 대체하거나 합성 이벤트를 실사용 성공으로 보고하지 않았다. 암호화 메시지의 원문 검증 한계는 원장과 호스트 계약 문서에 명시했다.
