# Tailscale 지원 계획 (v2 — 현실적 버전)

## 전제

Tailscale은 **이미 안전한 프라이빗 네트워크**입니다.
- WireGuard 기반 암호화 (IP 레이어)
- Tailnet 가입 시 인증 (SSO, OAuth 등)
- 네트워크 격리 (인터넷에서 접근 불가)

**따라서 앱 레이어 암호화(Ed25519, HMAC 등)는 불필요합니다.**
Tailnet 멤버를 못 믿으면 Tailnet에서 빼면 됩니다.

---

## 실제 블로커 4개와 해결책

### 블로커 1: 브로커가 127.0.0.1에만 바인드됨

**현재** (broker.ts:228-230):
```typescript
Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",  // 로컬만
```

**수정:**
```typescript
// 환경변수로 모드 전환
const NETWORK_MODE = process.env.CLAUDE_PEERS_NETWORK === "tailscale";

async function getListenAddress(): Promise<string> {
  if (!NETWORK_MODE) return "127.0.0.1";

  try {
    const proc = Bun.spawn(["tailscale", "ip", "-4"], {
      stdout: "pipe", stderr: "ignore",
    });
    const ip = (await new Response(proc.stdout).text()).trim();
    if ((await proc.exited) === 0 && ip) return ip;
  } catch {}

  // Tailscale 없으면 fallback
  return "127.0.0.1";
}

const listenAddr = await getListenAddress();

Bun.serve({
  port: PORT,
  hostname: listenAddr,  // Tailscale IP 또는 127.0.0.1
  // ...
});

console.error(`[broker] listening on ${listenAddr}:${PORT}`);
```

**변경량:** broker.ts에 10줄 추가

---

### 블로커 2: PID 기반 liveness 체크가 원격에서 안 됨

**현재** (broker.ts:62-73, 188-197):
```typescript
// 로컬 PID만 확인 가능
process.kill(peer.pid, 0);
```

**수정: heartbeat 기반 timeout으로 전환**
```typescript
// broker.ts

const PEER_TIMEOUT_MS = 60_000; // heartbeat 없으면 60초 후 dead 취급

function cleanStalePeers() {
  const now = Date.now();
  const peers = db.query("SELECT id, pid, last_seen, hostname FROM peers").all() as Array<{
    id: string; pid: number; last_seen: string; hostname: string;
  }>;

  const myHostname = require("os").hostname();

  for (const peer of peers) {
    let isAlive = false;

    if (peer.hostname === myHostname) {
      // 같은 머신이면 PID 체크 (기존 로직 유지)
      try {
        process.kill(peer.pid, 0);
        isAlive = true;
      } catch {}
    } else {
      // 원격 머신이면 heartbeat timeout 기반
      const lastSeen = new Date(peer.last_seen).getTime();
      isAlive = (now - lastSeen) < PEER_TIMEOUT_MS;
    }

    if (!isAlive) {
      db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);
    }
  }
}
```

**변경량:** cleanStalePeers() 함수 수정, handleListPeers()의 필터도 동일하게 수정

---

### 블로커 3: 머신 식별자 없음

**현재 peer 스키마에 hostname이 없음.**

**수정:**

```typescript
// shared/types.ts — RegisterRequest에 hostname 추가
export interface RegisterRequest {
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  hostname: string;       // NEW — os.hostname()
  tailscale_ip?: string;  // NEW — Tailscale IP (있으면)
}

export interface Peer {
  id: PeerId;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  hostname: string;        // NEW
  tailscale_ip: string | null; // NEW
  registered_at: string;
  last_seen: string;
}
```

```sql
-- broker.ts DB 스키마
CREATE TABLE IF NOT EXISTS peers (
  id TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  cwd TEXT NOT NULL,
  git_root TEXT,
  tty TEXT,
  summary TEXT NOT NULL DEFAULT '',
  hostname TEXT NOT NULL,        -- NEW
  tailscale_ip TEXT,             -- NEW
  registered_at TEXT NOT NULL,
  last_seen TEXT NOT NULL
)
```

```typescript
// server.ts — 등록할 때
import { hostname } from "os";

const reg = await brokerFetch<RegisterResponse>("/register", {
  pid: process.pid,
  cwd: myCwd,
  git_root: myGitRoot,
  tty,
  summary: initialSummary,
  hostname: hostname(),
  tailscale_ip: await getTailscaleIP(),  // null이면 로컬 모드
});
```

**변경량:** types.ts 2필드, broker.ts 스키마 2컬럼, server.ts 등록 2줄

---

### 블로커 4: 아키텍처 — 중앙 브로커 vs 분산

**두 가지 선택지:**

#### A. 중앙 브로커 (간단, 추천)
```
Machine A (broker)           Machine B
  broker:7899 ◄────────────► server.ts
  ↑                            ↑
  server.ts                    server.ts
  server.ts                    server.ts
```

- 한 대에서만 broker 실행
- 다른 머신의 server.ts는 중앙 broker의 Tailscale IP로 연결
- **장점:** 코드 변경 최소, 간단
- **단점:** broker 머신이 꺼지면 전체 중단

**구현:**
```typescript
// server.ts — BROKER_URL 변경
const BROKER_URL = process.env.CLAUDE_PEERS_BROKER
  ?? `http://127.0.0.1:${BROKER_PORT}`;

// 사용:
// 로컬 모드 (기본): 자동으로 localhost
// 네트워크 모드: CLAUDE_PEERS_BROKER=http://100.64.1.5:7899
```

```typescript
// server.ts — ensureBroker() 수정
async function ensureBroker(): Promise<void> {
  if (await isBrokerAlive()) {
    log("Broker already running");
    return;
  }

  // 원격 broker URL이 지정되어 있으면 자동 시작 안 함
  if (process.env.CLAUDE_PEERS_BROKER) {
    throw new Error(
      `Remote broker at ${BROKER_URL} is not reachable. ` +
      `Start the broker on that machine first.`
    );
  }

  // 로컬이면 기존 로직으로 자동 시작
  log("Starting broker daemon...");
  // ... (기존 코드 유지)
}
```

#### B. 브로커 연합 (복잡, 나중에)
```
Machine A (broker A) ◄──sync──► Machine B (broker B)
  ↑                                ↑
  server.ts                        server.ts
```

- 각 머신마다 자체 broker
- broker끼리 peer/message 동기화
- **장점:** 단일 장애점 없음
- **단점:** 훨씬 복잡, 동기화 충돌 처리 필요

**→ 나중에. 지금은 옵션 A로 충분.**

---

## 구현 계획 (실제 코드 변경량 기준)

### Step 1: 타입 + 스키마 업데이트 (30분)

변경 파일: `shared/types.ts`, `broker.ts`

```
types.ts:
  RegisterRequest에 hostname, tailscale_ip 추가
  Peer에 hostname, tailscale_ip 추가

broker.ts:
  DB 스키마에 hostname, tailscale_ip 컬럼 추가
  insertPeer에 두 필드 추가
```

### Step 2: server.ts — Tailscale 감지 + 원격 broker 지원 (1시간)

```typescript
// 추가할 함수
async function getTailscaleIP(): Promise<string | null> { ... }

// BROKER_URL 환경변수 지원
const BROKER_URL = process.env.CLAUDE_PEERS_BROKER
  ?? `http://127.0.0.1:${BROKER_PORT}`;

// ensureBroker()에서 원격이면 자동 시작 건너뜀

// 등록 시 hostname, tailscale_ip 포함
```

### Step 3: broker.ts — 네트워크 바인딩 + heartbeat 기반 정리 (1시간)

```typescript
// getListenAddress() 추가
// cleanStalePeers() — 원격 peer는 heartbeat timeout 기반으로 전환
// handleListPeers() — 같은 로직 적용
```

### Step 4: list_peers 출력에 hostname 표시 (30분)

```typescript
// server.ts의 list_peers 핸들러
const parts = [
  `ID: ${p.id}`,
  `Host: ${p.hostname}`,     // NEW
  `PID: ${p.pid}`,
  `CWD: ${p.cwd}`,
];
if (p.tailscale_ip) parts.push(`Tailscale: ${p.tailscale_ip}`);
```

### Step 5: CLI 업데이트 (30분)

```typescript
// cli.ts — BROKER_URL 환경변수 지원 (이미 BROKER_PORT는 지원)
const BROKER_URL = process.env.CLAUDE_PEERS_BROKER
  ?? `http://127.0.0.1:${BROKER_PORT}`;
```

### Step 6: 테스트 (1시간)

- 로컬 모드 (기존 동작 유지 확인)
- Tailscale 모드 (두 머신에서 테스트)

---

## 총 예상 시간: 반나절 (4-5시간)

이전 분석에서 "2-4주"라고 했지만, 실제 변경량은 매우 적습니다:
- types.ts: 2개 필드 추가
- broker.ts: 바인딩 로직 + heartbeat timeout (~30줄)
- server.ts: Tailscale IP 감지 + BROKER_URL 환경변수 (~20줄)
- cli.ts: BROKER_URL 환경변수 (~1줄)

암호화/서명/HMAC 레이어가 불필요하기 때문입니다.

---

## 환경변수 정리

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `CLAUDE_PEERS_PORT` | `7899` | 브로커 포트 (기존) |
| `CLAUDE_PEERS_DB` | `~/.claude-peers.db` | DB 경로 (기존) |
| `CLAUDE_PEERS_BROKER` | (자동) | 원격 브로커 URL (NEW) |
| `CLAUDE_PEERS_NETWORK` | (없음) | `tailscale`이면 Tailscale IP에 바인드 (NEW) |
| `OPENAI_API_KEY` | (없음) | 자동 요약 (기존) |

---

## 사용법

### 로컬 모드 (기존, 변경 없음)
```bash
claude --dangerously-load-development-channels server:claude-peers
```

### Tailscale 모드

**머신 A (broker):**
```bash
# broker를 Tailscale IP에 바인드
CLAUDE_PEERS_NETWORK=tailscale bun broker.ts

# Claude 시작 (자동으로 로컬 broker 사용)
claude --dangerously-load-development-channels server:claude-peers
```

**머신 B (client):**
```bash
# 머신 A의 broker에 연결
export CLAUDE_PEERS_BROKER=http://100.64.1.5:7899

# Claude 시작 (원격 broker 사용, 자동 시작 안 함)
claude --dangerously-load-development-channels server:claude-peers
```

---

## 보안에 대해

### 추가 암호화가 필요 없는 이유

1. **Tailscale = WireGuard** — 모든 패킷이 ChaCha20-Poly1305로 암호화됨
2. **Tailnet 가입 = 인증** — 네트워크에 있다는 것 자체가 인증된 사용자
3. **claude-peers의 목적** — 같이 일하는 Claude 인스턴스끼리 소통. "보안 메시징"이 아님
4. **위협 모델의 현실** — Tailnet 멤버가 악의적이면, peers 메시지 위조보다 훨씬 심각한 공격이 가능 (SSH, 파일시스템 접근 등)

### 그래도 하면 좋은 것 (nice-to-have)

| 항목 | 이유 | 난이도 | 우선순위 |
|------|------|--------|---------|
| DB 파일 권한 0600 | 공유 서버에서 다른 유저의 DB 읽기 방지 | 1줄 | 낮음 |
| Message TTL | DB 무한 증가 방지 | 5줄 | 중간 |
| Rate limiting | 실수로 루프 돌 때 보호 | 15줄 | 낮음 |
| from_id 검증 | 등록된 peer만 메시지 전송 가능 | 3줄 | 중간 |

`from_id` 검증은 간단합니다:
```typescript
// broker.ts handleSendMessage — 3줄 추가
const sender = db.query("SELECT id FROM peers WHERE id = ?").get(body.from_id);
if (!sender) {
  return { ok: false, error: "Sender not registered" };
}
```

이 정도면 CLI에서 `from_id: "cli"`로 보내는 것도 막히고, 등록 안 한 프로세스의 위조도 막힙니다.

---

## 이전 분석 대비 변경점

| 이전 분석 | 이번 검토 |
|----------|----------|
| HMAC 필요 (Phase 1) | ❌ HMAC 설계가 깨져있음. Tailscale에서는 불필요 |
| Ed25519 필요 (Phase 3) | ❌ 과도한 엔지니어링 |
| UID 필터링 필요 | ⚠️ Nice-to-have (공유 서버에서만 의미) |
| 2-4주 소요 | ❌ 실제로는 반나절 |
| 5개 문서, 수천 줄 | 이 문서 하나면 충분 |
| 보안이 핵심 블로커 | ❌ 아키텍처(PID, 바인딩, hostname)가 핵심 블로커 |
