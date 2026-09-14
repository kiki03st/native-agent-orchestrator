# 모델 선택 정책

이는 배포판의 시작 기준이며 측정된 속도·정확도 순위가 아닙니다. 실제 호스트의 모델 목록·추론 수준·계정 권한을 확인한 뒤 선택하고, 불가능하면 중단 이유를 알립니다. 모델을 조용히 바꾸지 않습니다.

| 호스트 | 모델 / 기본 추론 | 작업 후보 |
| --- | --- | --- |
| Codex | GPT-5.6 Luna / medium | 명확하고 작은 반복 변경·추출·검사 |
| Codex | GPT-5.6 Terra / medium | 일반 기능 구현 |
| Codex | GPT-5.6 Sol / high | 다중 파일 디버깅·리뷰 |
| Codex | GPT-6 Astra / high | 모호하고 영향이 큰 설계·판단 |
| Claude Code | Haiku / default | 짧고 명확한 추출·검사·작은 변경 |
| Claude Code | Sonnet / high 또는 medium | 일반 구현·디버깅·리뷰, 작은 지연 민감 작업은 medium 후보 |
| Claude Code | Opus / high, 필요시 xhigh | 깊은 분석·설계·어려운 리뷰 |
| Claude Code | Fable / high | 사용자 요청과 계정 지원이 있을 때만 긴 복합 작업 후보 |

Claude의 별칭은 계정·공급자·설정에 따라 실제 모델 버전이 달라질 수 있습니다. 계획은 별칭과 추론 수준을 명시하고, 검증 보고에는 실제 모델 ID와 추론 수준을 기록합니다. Haiku의 `default`는 effort를 전달하지 않는다는 내부 표기입니다. 18개 Claude 프로필은 모델/추론 조합 6개에 병렬 슬롯 3개를 배정한 것입니다.

단순 질문·설명·진행 확인은 위 표와 관계없이 현재 세션에서 처리합니다. 복잡한 작업도 항상 최고가 모델을 쓰는 규칙은 아닙니다. 변경 시 `src/policy.json`, 두 coordinator 문서와 이 문서를 함께 검토하고 `npm run build`로 배포본을 갱신합니다.

공식 참고: [Codex 하위 에이전트](https://learn.chatgpt.com/docs/agent-configuration/subagents), [Claude 모델 설정](https://code.claude.com/docs/en/model-config), [Claude 하위 에이전트](https://code.claude.com/docs/en/subagents), [Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort).
