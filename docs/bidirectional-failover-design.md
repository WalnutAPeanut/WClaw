# 양방향 Provider Failover 설계문서

**목표:** provider 장애 시 같은 턴을 다른 provider로 자동 재실행한다.
`codex` 장애 → `claude`, `claude` 장애 → `codex`.

**상태:** ✅ **구현 완료 (2026-05-31)**. 트리거 범위 = **장애만** (턴 타임아웃 제외, §8 참고).
**작성:** 2026-05-31. 영감: [phj1081/EJClaw](https://github.com/phj1081/EJClaw)의 단방향 Claude→Codex failover.

> **구현 요약 (설계대로):** 신규 `container/agent-runner/src/providers/failure-classification.ts`(에러→사유 분류) + `providers/failover.ts`(`otherProvider`/`shouldFailover`). `poll-loop.ts`에 `runTurnAttempt`로 턴을 추출하고, 1차 실패가 outage(`shouldFailover`)이며 가시 출력 전(`!sawVisibleOutput`)이면 파트너 provider로 같은 prompt를 **턴당 1회** 재실행. `processQuery`가 `{type:'error'}` 이벤트를 분류·래치(결과 도착 시 해제)하고 `sawVisibleOutput`을 추적. 파트너는 `index.ts`에서 옵션과 함께 미리 생성해 `PollLoopConfig.failoverProvider`로 주입(provider별 continuation 분리라 파트너는 자기 세션 resume). 설정: `config.ts`의 `autoFailover`(container.json, 기본 ON). 테스트: `failure-classification.test.ts`, `failover.test.ts`, `poll-loop.failover.test.ts` — agent-runner 전체 **127 pass**, 타입체크 클린. 컨테이너 src 바인드 마운트라 **이미지 재빌드 불필요**.

---

## 1. 범위

| 항목 | 결정 |
| --- | --- |
| 방향 | **양방향** (codex↔claude) |
| 트리거 | provider **장애만** — auth-expired/401, usage-exhausted, 429 rate-limit, overloaded/503, network-error |
| 제외 | 턴 타임아웃(15분), 정상 빈 응답, 사용자 측 에러, MCP 도구 에러 |
| 가드 | 이미 사용자에게 출력이 나간 턴은 failover 안 함 (중복 답장 방지) |
| 횟수 | 턴당 **1회** failover (핑퐁 방지) |
| 적용 단위 | per-agent-group (설정으로 on/off) |
| 컨테이너 | src가 런타임 바인드 마운트라 **이미지 재빌드 불필요** |

---

## 2. EJClaw 코드를 그대로 못 쓰는 이유

| EJClaw | NanoClaw v2 |
| --- | --- |
| 호스트 프로세스 tribunal (owner/reviewer/arbiter) | 컨테이너-per-세션, 단일 에이전트 |
| `ServiceHandoff` SQLite 레코드로 역할 간 turn 이관 | 턴은 컨테이너 poll-loop 안에서 완결 |
| `if (!hasReviewer) return none` — reviewer 역할 필수 | 역할 개념 없음 |
| `target_agent_type: 'codex'` **하드코딩 (단방향)** | 양방향 필요 |

→ failover **plumbing**(handoff 레코드/역할 라우팅)은 이식 불가.
→ 재사용 가능한 알맹이는 **에러 분류 로직** `src/agent-error-detection.ts` 하나. 이것만 포팅·보강한다.

---

## 3. 현재 아키텍처 (구현 근거)

모든 참조는 `container/agent-runner/src/` 기준.

- **Provider 추상화** — `providers/types.ts:1` `AgentProvider` 인터페이스, `providers/factory.ts:11` `createProvider(name, opts)`. `claude.ts`·`codex.ts` 둘 다 등록되어 **한 컨테이너 안에 공존 가능** (상호 배제 없음).
- **이벤트 모델** — `providers/types.ts:97` `ProviderEvent`:
  `init | result | error{message,retryable,classification?} | progress | activity`.
- **턴 실행** — `poll-loop.ts:207` `config.provider.query({prompt, continuation, cwd, systemContext})` → `poll-loop.ts:221` `processQuery(...)`.
- **에러 경로 2가지:**
  1. **예외** → `poll-loop.ts:226` catch → `isSessionInvalid` 검사 후 `"Error: ..."` 메시지를 사용자에게 씀. **재시도 없음.**
  2. **`{type:'error'}` 이벤트** → `poll-loop.ts:476` `handleEvent`에서 **로그만**. 사용자에게 안 보이고 예외도 아님. (claude: `api_retry`/`rate_limit_event`, codex: `turn/failed`)
- **가시 출력 신호** — `poll-loop.ts:444` `dispatchResultText(text)` → `{sent, hasUnwrapped}`. `sent>0`이면 사용자에게 실제 전송됨. (추가로 MCP `send_message`로 mid-turn 전송 가능 → §6 가드에서 고려)
- **continuation** — provider 이름별로 분리 저장 (`setContinuation(providerName, ...)`, `poll-loop.ts:222`/`435`). **provider를 바꾸면 자동으로 새 세션 시작** → failover의 핵심 enabler. 충돌·오염 없음.
- **provider 선택** — `index.ts:43` `loadConfig().provider` → `createProvider`. 컨테이너 수명 동안 고정. **failover는 이 고정을 턴 단위로 1회 우회하는 것.**
- **설정 로드** — `config.ts:11` `RunnerConfig`, `/workspace/agent/container.json`에서 읽음. 호스트가 `src/container-config.ts:33` `ContainerConfig` + `materializeContainerJson()`로 DB(`container_configs`)에서 생성.

---

## 4. 설계 개요

```
poll-loop turn:
  primary = config.provider            (예: codex)
  attempt(primary):
    query + processQuery
    ├─ 성공 → 끝
    └─ 실패:
         reason = classifyProviderFailure(예외 or error이벤트)
         if reason ∈ FAILOVER_REASONS
            and !sawVisibleOutput          ← 중복 답장 방지 (핵심)
            and !alreadyFailedOver          ← 턴당 1회
            and failoverEnabled:
              secondary = otherProvider(primary)   (codex→claude / claude→codex)
              log "failover: {primary} {reason} → {secondary}"
              attempt(secondary)            ← 같은 prompt, secondary continuation
              알림: (옵션) "⚠️ {primary} 장애로 {secondary}가 응답합니다"
         else:
              기존처럼 "Error: ..." 사용자에게
```

핵심 설계 포인트:
- **같은 prompt 재사용** — 첫 시도가 사용자 출력을 못 냈으므로 prompt를 그대로 secondary에 재투입.
- **secondary continuation** — provider별 분리 저장이라 secondary는 자기 과거 세션을 자연 resume(있으면) 또는 새로 시작. 추가 작업 0.
- **provider 인스턴스 지연 생성** — secondary는 failover 시점에 `createProvider(secondary, sameOpts)`로 1회 생성 후 캐시.

---

## 5. 파일별 변경

### 5.1 신규: `container/agent-runner/src/providers/failure-classification.ts`
EJClaw `agent-error-detection.ts`를 **포팅·축소**. 텍스트/에러 → 분류.

```ts
export type FailureReason =
  | 'auth-expired' | 'usage-exhausted' | 'rate-limit'
  | 'overloaded' | 'network-error' | 'none';

// 예외(throw) 또는 {type:'error'} 이벤트 둘 다 받음
export function classifyProviderFailure(
  input: { errorText: string; classification?: string }
): FailureReason
```
- claude 패턴: `failed to authenticate`+401, `you're out of extra usage`, `api error: 429`, `overloaded`(503), `fetch failed`/`network error` 등 (EJClaw `isClaude*` 함수들 기반).
- codex 패턴: `turn/failed` 메시지의 401/429/`usage limit`/`unauthorized`/네트워크. (EJClaw `isCodexRotationReason` 대응 + codex 실제 에러 텍스트 확인 보강 필요 — §7-R4)
- **테스트 동봉** (`failure-classification.test.ts`, bun:test).

### 5.2 신규: `container/agent-runner/src/providers/failover.ts`
```ts
export function otherProvider(name: ProviderName): ProviderName | null
  // 'codex' -> 'claude', 'claude' -> 'codex', 그 외 -> null (mock/opencode 등은 failover 제외)

const FAILOVER_REASONS: Set<FailureReason>  // none/timeout 제외
export function shouldFailover(reason: FailureReason): boolean
```

### 5.3 수정: `poll-loop.ts`
- **출력 추적**: 턴 단위 `sawVisibleOutput` 플래그.
  - `dispatchResultText`가 `sent>0` 반환 시 true. (`poll-loop.ts:444`)
  - MCP mid-turn 전송도 카운트 — `setCurrentInReplyTo` 근처 outbound write hook 또는 전송 카운터 1개. (보수적: outbound row가 이번 배치로 하나라도 생겼으면 true)
- **분류 신호 수집**: `processQuery`가 `{type:'error'}` 이벤트의 마지막 분류를 반환값에 포함하도록 확장 → `return { continuation, lastError? }`.
- **failover 래퍼**: `poll-loop.ts:218~252`의 try/catch를 `runAttempt(provider, providerName)` 헬퍼로 추출하고, 실패 시 §4 조건 검사 후 secondary로 `runAttempt` 1회 재호출.
  - 예외 경로(`:226`)와 error-이벤트 경로 둘 다 `classifyProviderFailure`로 통일.
  - secondary도 실패하면 그때 `"Error: ..."` 메시지.

### 5.4 설정 플래그
- `container/agent-runner/src/config.ts:11` `RunnerConfig`에 `autoFailover: boolean` 추가 (기본 true).
- `src/container-config.ts:33` `ContainerConfig` + `materializeContainerJson()`에 `autoFailover` 전달.
- **DB**: `container_configs`에 컬럼 추가는 선택. v1은 마이그레이션 없이 **기본 켜짐 + 환경/컨벤션**으로 시작 가능:
  - 컨테이너에 known pair(codex↔claude)면 자동 enable, `autoFailover:false`로만 끄기.
  - 끄기 노출이 필요하면 `container_configs.auto_failover` 컬럼 + `ncl groups config update --auto-failover false`.

### 5.5 (옵션) 사용자 알림
secondary가 응답하기 직전, 작은 시스템 메시지 1줄:
`⚠️ {primary} 일시 장애 — {secondary}로 응답합니다`. 기본 off, 설정으로 on.

---

## 6. "가시 출력" 가드 (가장 중요)

failover는 **첫 시도가 사용자에게 아무것도 못 보냈을 때만** 한다. 안 그러면 같은 질문에 두 번 답이 나간다.

- 다행히 대상 장애(auth/429/usage/overloaded/network)는 **턴 시작 직후 API 호출에서 즉시 실패**하므로 보통 `sawVisibleOutput=false`다 → 가드는 안전망.
- mid-turn에 일부 전송 후 실패하는 드문 경우 → 가드가 막아 failover 안 함 → 기존처럼 `"Error:"` 노출 (안전).

---

## 7. 엣지 케이스 / 리스크

- **R1 핑퐁**: secondary도 같은 류 장애면? → 턴당 1회 cap. secondary 실패는 곧장 사용자 에러.
- **R2 중복 답장**: §6 가드로 차단. 구현 시 `sawVisibleOutput` 정확도가 핵심 — MCP mid-turn 전송 카운트 누락 주의.
- **R3 continuation 혼선**: provider별 분리 저장이라 안전. 단 failover 후 사용자가 이어 말하면 secondary 세션이 이어짐(컨테이너는 여전히 primary 고정) → 다음 턴은 primary로 복귀하며 primary continuation 사용. **대화 맥락이 두 세션으로 갈릴 수 있음** → 수용 가능(장애는 일시적), 또는 "failover 후 N턴 secondary 고정" 정책 추가 검토(§9 후속).
- **R4 codex 에러 텍스트 미확인**: codex `turn/failed`의 실제 message 포맷(401/429/usage limit 문자열)을 로그로 수집해 분류기 정확도 검증 필요. **구현 전 1차 작업.**
- **R5 인증 자체가 양쪽 다 죽은 경우**: 둘 다 실패 → 사용자 에러. 정상 동작.
- **R6 codex 미설치 환경**: `otherProvider`가 claude만 있으면? createProvider('codex') 가능 여부 확인 — 현재 설치 완료(메모리 기준). 미설치 provider면 failover skip + 로그.

---

## 8. 명시적 제외 (이번 범위 아님)

- **턴 타임아웃(15분) failover** — 사용자 선택으로 제외. (원하면 `session-failure`류로 후속 추가 가능; 단 타임아웃은 "느림"이지 "장애"가 아니라 secondary도 느릴 수 있음.)
- **토큰 로테이션** — EJClaw의 Claude 멀티 OAuth 토큰 로테이션은 별개 기능. 범위 밖.
- **정상 빈 응답(`success-null-result`)** — failover 트리거 아님.

---

## 9. 롤아웃 & 테스트

**테스트:**
- `failure-classification.test.ts` — 각 reason의 양성/음성 케이스 (claude·codex 텍스트).
- `failover.test.ts` — `otherProvider`, `shouldFailover`.
- poll-loop 통합 테스트 — mock provider 2개로 "primary가 reason throw → secondary가 result" 시나리오, "가시 출력 후 실패 → failover 안 함", "secondary도 실패 → 에러" (bun:test, `MockProvider` 활용).

**배포:**
1. 코드/테스트 작성 → `cd container/agent-runner && bun test` + `bun run typecheck`.
2. src가 런타임 마운트라 **이미지 재빌드 불필요**.
3. 설정 컬럼 추가 시에만 호스트 `pnpm run build` + 마이그레이션 + 서비스 재시작.
4. 컨테이너 재시작: `./bin/ncl groups restart --id <ag-id>` → 다음 메시지부터 적용.
5. 검증: primary(codex) 인증 일시 차단 등으로 실제 failover 로그 확인.

**후속 (선택):**
- failover 후 secondary 고정 N턴 정책(R3).
- 턴 타임아웃 트리거 추가.
- 메트릭: failover 발생 횟수/사유 로깅 → 대시보드.

---

## 10. 규모 추정

| 작업 | 규모 |
| --- | --- |
| `failure-classification.ts` + 테스트 | 중 (EJClaw 포팅 + codex 보강) |
| `failover.ts` + 테스트 | 소 |
| `poll-loop.ts` 래퍼 + 출력추적 | 중 (핵심, 신중히) |
| 설정 플래그 (컬럼 없이) | 소 |
| 통합 테스트 | 중 |

**선행 작업 1건**: codex `turn/failed` 실제 에러 텍스트 샘플 수집 (R4) — 분류기 정확도의 전제.
