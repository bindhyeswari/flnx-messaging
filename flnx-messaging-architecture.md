# flnx-messaging — Architecture & Security Design

**Version:** 0.1.0-draft
**Runtime:** Bun (compiled to single binary)
**Language:** TypeScript (strict mode)
**Distribution:** CLI tool via `bunx flnx-messaging` or standalone binary

---

## 1. Vision & Constraints

flnx-messaging is a stateless, single-binary CLI tool that lets AI coding agents (Claude Code, Codex, etc.) and developers send, read, and react to messages across platforms — starting with Slack, designed to extend to Discord, Teams, and Telegram.

**Design principles:**

- **Stateless by default.** Each invocation is an independent operation. No daemon, no background process, no persistent WebSocket. This eliminates entire classes of vulnerabilities (session hijacking, state corruption, memory poisoning).
- **Least agency.** Borrowed from OWASP's Agentic Top 10 (2026) — the tool does the minimum required. It is a pipe, not an agent. It does not interpret message content, make decisions, or take autonomous action.
- **Defense in depth.** Security is layered: credential isolation → input validation → output sanitization → audit logging → rate limiting.
- **Zero trust on content.** All inbound message content is treated as untrusted. The tool never evaluates, executes, or interprets message payloads.

---

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    CLI Entry Point                       │
│              (arg parsing, command routing)              │
└──────────────────────┬──────────────────────────────────┘
                       │
         ┌─────────────┼─────────────────┐
         ▼             ▼                 ▼
   ┌───────────┐ ┌───────────┐    ┌───────────┐
   │  Command  │ │  Command  │    │  Command  │
   │   send    │ │   read    │    │   react   │
   └─────┬─────┘ └─────┬─────┘    └─────┬─────┘
         │             │                 │
         └─────────────┼─────────────────┘
                       ▼
         ┌─────────────────────────────┐
         │      Validation Layer       │
         │  (input sanitization, rate  │
         │   limiting, size guards)    │
         └─────────────┬───────────────┘
                       ▼
         ┌─────────────────────────────┐
         │     Platform Adapter        │
         │   (normalized interface)    │
         └─────┬───────┬───────┬───────┘
               │       │       │
               ▼       ▼       ▼
         ┌───────┐ ┌───────┐ ┌───────┐
         │ Slack │ │Discord│ │ Teams │   ← Platform SDKs
         └───┬───┘ └───┬───┘ └───┬───┘
             │         │         │
             ▼         ▼         ▼
         ┌─────────────────────────────┐
         │     HTTP Transport Layer    │
         │  (TLS-only, retry, timeout) │
         └─────────────┬───────────────┘
                       ▼
         ┌─────────────────────────────┐
         │       Audit Logger          │
         │  (structured JSON, redacted │
         │   credentials, timestamps)  │
         └─────────────────────────────┘
```

---

## 3. Module Breakdown

### 3.1 CLI Entry Point (`src/cli.ts`)

Parses commands and flags using a zero-dependency argument parser (or `commander` if preferred). Routes to command handlers.

```
flnx send --platform slack --channel "#ops" --text "Deploy complete"
flnx read --platform slack --channel "#ops" --limit 10 --json
flnx react --platform slack --channel "#ops" --ts "1712023032.1234" --emoji "white_check_mark"
flnx upload --platform slack --channel "#ops" --file ./report.pdf
flnx channels --platform slack
flnx status
```

**Exit codes** follow Unix convention: 0 success, 1 general error, 2 auth error, 3 validation error, 4 rate limit, 5 network error.

### 3.2 Command Handlers (`src/commands/`)

Each command is a pure function: `(validated_args, adapter) → Result<Output, FlnxError>`. No side effects outside the adapter call and the audit log write. Each handler:

1. Validates input through the validation layer
2. Acquires credentials through the credential manager
3. Calls the platform adapter
4. Logs the operation
5. Formats and returns output

### 3.3 Validation Layer (`src/validation/`)

All input is validated before reaching any platform adapter. This is the primary defense against injection and misuse.

**Input validation rules (aligned with OWASP API Security Top 10, API8:2023 — Security Misconfiguration):**

| Field | Constraints |
|-------|-------------|
| `--text` | Max 40,000 chars (Slack limit). UTF-8 only. No null bytes. |
| `--channel` | Must match `^[#@]?[a-zA-Z0-9_-]{1,80}$` or Slack channel ID `^[CDGW][A-Z0-9]{8,}$` |
| `--file` | Must exist on disk. Max 100MB. MIME type validated against allowlist. |
| `--emoji` | Must match `^[a-z0-9_+-]{1,100}$` (Slack shortcode format) |
| `--ts` | Must match `^\d{10}\.\d{1,6}$` (Slack message timestamp) |
| `--limit` | Integer, 1–1000 |
| `--platform` | Enum: `slack`, `discord`, `teams`, `telegram` |

**Rejected patterns:** Any input containing control characters (U+0000–U+001F except newline/tab), excessively long strings, or patterns matching known injection vectors.

### 3.4 Platform Adapter Interface (`src/adapters/`)

Borrowed from OpenClaw's channel adapter pattern — a normalized interface that all platforms implement:

```typescript
interface PlatformAdapter {
  readonly platform: PlatformType;

  send(params: SendParams): Promise<Result<SendResult, PlatformError>>;
  read(params: ReadParams): Promise<Result<ReadResult, PlatformError>>;
  react(params: ReactParams): Promise<Result<void, PlatformError>>;
  upload(params: UploadParams): Promise<Result<UploadResult, PlatformError>>;
  listChannels(): Promise<Result<Channel[], PlatformError>>;
  healthCheck(): Promise<Result<HealthStatus, PlatformError>>;
}

// Normalized message envelope — platform-agnostic
interface Message {
  id: string;
  platform: PlatformType;
  channelId: string;
  channelName?: string;
  senderId: string;
  senderName?: string;
  text: string;
  timestamp: Date;
  threadId?: string;
  attachments?: Attachment[];
}
```

**Why an adapter pattern:** The adapter pattern lets us swap platform implementations without changing any command logic, and gives us a single place to enforce security policy per platform. Unlike OpenClaw's bidirectional channel adapters (which must also listen for events, handle threading, manage sessions), ours are unidirectional and stateless — radically simpler to secure and maintain.

### 3.5 Slack Adapter (`src/adapters/slack.ts`)

Uses Slack's current Web API surface via `fetch()` (Bun-native, no additional dependencies).

**API methods used:**

| Operation | Slack API Method |
|-----------|-----------------|
| Send message | `chat.postMessage` |
| Read messages | `conversations.history` |
| Add reaction | `reactions.add` |
| Upload file | `files.getUploadURLExternal` + `files.completeUploadExternal` |
| List channels | `conversations.list` |
| Health check | `auth.test` |

Note: File uploads use the current two-step flow — the legacy `files.upload` was deprecated May 2024 and fully retired March 2025.

### 3.6 HTTP Transport Layer (`src/transport/`)

All outbound HTTP handled by a single transport module:

- **TLS-only.** Rejects any non-HTTPS endpoint. No configuration override.
- **Timeout.** 30s default, configurable per-operation. Hard cap at 120s.
- **Retry.** Exponential backoff with jitter for 429 (rate limit) and 5xx. Max 3 retries. Respects `Retry-After` header.
- **No redirects.** Does not follow HTTP redirects to prevent SSRF-class attacks.
- **Response size cap.** 50MB max response body to prevent memory exhaustion.

### 3.7 Audit Logger (`src/audit/`)

Every operation produces a structured JSON log entry to stderr (or to a file via `--audit-log`).

```json
{
  "timestamp": "2026-03-07T14:30:00.000Z",
  "command": "send",
  "platform": "slack",
  "channel": "#ops",
  "status": "success",
  "latency_ms": 342,
  "token_hint": "xoxb-...a4f2",
  "error": null
}
```

**What is logged:** command, platform, channel, status, latency, last 4 chars of token (for debugging which token was used), error messages.

**What is never logged:** message content, full tokens, file contents, user IDs beyond what's needed for debugging. This aligns with OWASP MCP01:2025 (Token Mismanagement) — credentials must never appear in logs.

---

## 4. Security Architecture

### 4.1 Credential Management

This is the highest-risk surface. A compromised token grants full access to a Slack workspace.

**Credential resolution order** (first match wins):

1. `--token` flag (for scripting — warned as insecure in `--help`)
2. Environment variable per platform: `FLNX_SLACK_TOKEN`, `FLNX_DISCORD_TOKEN`, etc.
3. Credential file: `~/.config/flnx/credentials.json` (mode 0600, owner-only)
4. System keychain (macOS Keychain, Linux Secret Service) via optional integration

**Credential file format:**

```json
{
  "version": 1,
  "credentials": {
    "slack": {
      "default": {
        "token": "xoxb-...",
        "scopes": ["chat:write", "channels:read", "channels:history",
                    "reactions:write", "files:read", "files:write"],
        "created_at": "2026-03-07T00:00:00Z",
        "expires_at": null
      }
    }
  }
}
```

**Security controls on credentials (OWASP MCP01:2025 + OWASP A07:2025 aligned):**

| Control | Implementation |
|---------|---------------|
| File permissions | Created with mode 0600. Startup check rejects if group/other readable. |
| No hardcoding | Binary never contains tokens. CI/CD docs recommend env injection only. |
| Token validation | On first use, calls `auth.test` to verify token is live and scopes match. |
| Scope minimization | Warns if token has scopes beyond what flnx-messaging uses. |
| Rotation support | `flnx credential rotate` subcommand to replace a token. |
| Memory handling | Token strings are not cached beyond the single request lifecycle. |
| No token in args | `--token` usage triggers a warning: visible in process lists (`ps aux`). |

### 4.2 Input Sanitization (OWASP A03:2025 — Injection)

flnx-messaging does not interpret message content — it is a transport tool. But it still sanitizes to prevent:

- **Slack API injection:** Malformed JSON payloads that could exploit Slack's API parsing.
- **Command injection:** If any shell expansion were to occur (it shouldn't — Bun's `fetch` doesn't shell out).
- **Log injection:** Newlines and control characters in user input stripped before logging.

```typescript
function sanitizeForLog(input: string): string {
  return input
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '') // strip control chars
    .replace(/\n/g, '\\n')                            // escape newlines
    .slice(0, 200);                                    // truncate for log safety
}

function validateMessageText(text: string): Result<string, ValidationError> {
  if (text.length === 0) return Err('Message text cannot be empty');
  if (text.length > 40_000) return Err('Message exceeds 40,000 character limit');
  if (/\x00/.test(text)) return Err('Message contains null bytes');
  return Ok(text);
}
```

### 4.3 Output Sanitization

When reading messages (inbound from Slack), content is treated as **untrusted by default**. This is critical when flnx-messaging output is consumed by an AI agent.

**OWASP ASI01:2026 (Agent Goal Hijack) mitigation:**

```typescript
function sanitizeInboundMessage(msg: SlackMessage): Message {
  return {
    id: msg.ts,
    text: msg.text,           // passed through as-is — consumer decides trust
    _flnx_untrusted: true,    // metadata flag for downstream consumers
    _flnx_source: 'slack',
    // ...
  };
}
```

When `--json` output is used, every message carries `_flnx_untrusted: true` so consuming agents/scripts know this content was not generated by flnx and should not be interpreted as instructions.

### 4.4 Rate Limiting (OWASP API4:2023 — Unrestricted Resource Consumption)

Client-side rate limiting to prevent accidental API abuse:

| Platform | Default limit | Window |
|----------|--------------|--------|
| Slack | 50 requests | 60 seconds |
| Discord | 30 requests | 60 seconds |
| Teams | 30 requests | 60 seconds |

Implemented via a simple token bucket stored in a temp file (`/tmp/flnx-ratelimit-<uid>.json`). The file is advisory — if it's missing or corrupt, the tool continues without rate limiting (fail-open for usability, since Slack's server-side limits are the real enforcement).

### 4.5 Supply Chain Security (OWASP A03:2025 — Software Supply Chain Failures)

| Control | Implementation |
|---------|---------------|
| Minimal dependencies | Target: zero runtime npm dependencies. Use Bun built-ins (`fetch`, `crypto`, arg parsing). |
| Lockfile pinning | `bun.lock` committed. All dependency versions pinned exactly. |
| SBOM generation | `flnx sbom` subcommand generates CycloneDX SBOM of the compiled binary. |
| Binary signing | Release binaries signed. Checksums published alongside releases. |
| No postinstall scripts | `package.json` disables lifecycle scripts from dependencies. |
| Dependency audit | CI runs `bun audit` on every PR. Fails on high/critical. |

### 4.6 Network Security

| Control | Implementation |
|---------|---------------|
| TLS-only | All outbound connections HTTPS. No HTTP fallback. No override. |
| No redirect following | Prevents SSRF via open redirect on platform APIs. |
| DNS pinning | Optional: `--pin-dns` flag to pin resolved IPs for the session. |
| Certificate validation | Bun's default TLS validation. No `rejectUnauthorized: false`. |
| Outbound allowlist | Only connects to known API hosts: `slack.com`, `discord.com`, `graph.microsoft.com`, `api.telegram.org`. |
| Proxy support | Respects `HTTPS_PROXY` / `NO_PROXY` environment variables. |

### 4.7 Threat Model

| Threat | Attack vector | Mitigation | OWASP ref |
|--------|--------------|------------|-----------|
| Token theft | Process list, env dump, log scraping | Token hint logging only (last 4 chars), `--token` warning, 0600 file perms | MCP01:2025, A07:2025 |
| Prompt injection via messages | Malicious Slack message read by AI agent | `_flnx_untrusted` flag on all inbound content, no interpretation of content | ASI01:2026 |
| Credential in LLM memory | AI agent stores token in conversation | Docs warn against passing tokens to stdin; prefer env vars | MCP01:2025 |
| API abuse / rate limit ban | Runaway script sends thousands of messages | Client-side token bucket rate limiter | API4:2023 |
| Dependency hijack | Malicious npm package in supply chain | Zero runtime deps target, lockfile pinning, SBOM | A03:2025 |
| SSRF | Redirect to internal network | No redirect following, outbound host allowlist | A01:2025 |
| Log injection | Control chars in message text | Sanitized before logging, truncated | A09:2025 |
| Denial of service | Massive response body | 50MB response cap, 120s hard timeout | API4:2023 |
| Man-in-the-middle | Intercept API traffic | TLS-only, no cert validation bypass | A02:2025 |
| Token over-provisioning | Bot token with admin scopes | Scope check on first use, warning for excess scopes | ASI04:2026 |

---

## 5. Configuration

flnx-messaging uses a layered configuration model. No config file is required — everything works with env vars alone.

**Optional config file:** `~/.config/flnx/config.json`

```json
{
  "version": 1,
  "defaults": {
    "platform": "slack",
    "output": "text"
  },
  "platforms": {
    "slack": {
      "default_channel": "#engineering",
      "rate_limit": 50,
      "timeout_ms": 30000
    }
  },
  "audit": {
    "enabled": true,
    "file": null,
    "redact_content": true
  },
  "security": {
    "warn_token_in_args": true,
    "check_file_permissions": true,
    "check_token_scopes": true,
    "outbound_allowlist": [
      "slack.com",
      "discord.com",
      "graph.microsoft.com",
      "api.telegram.org"
    ]
  }
}
```

**Resolution order:** CLI flag → environment variable → config file → default.

---

## 6. Output Formats

Two modes controlled by `--output` or `--json` shorthand:

**Text mode (default):** Human-readable, designed for terminal and AI agent consumption.

```
[2026-03-07 14:30:02] @alice in #ops:
  Deploy to production completed successfully.

[2026-03-07 14:28:15] @bob in #ops:
  Starting deploy pipeline for v2.4.1
```

**JSON mode (`--json`):** Machine-readable, one JSON object per line (NDJSON). Suitable for piping into `jq`, scripts, or AI agent tool use.

```json
{"id":"1709823002.001","channel":"#ops","sender":"alice","text":"Deploy to production completed successfully.","timestamp":"2026-03-07T14:30:02Z","_flnx_untrusted":true,"_flnx_source":"slack"}
```

---

## 7. Error Handling

All errors are typed and structured:

```typescript
type FlnxError =
  | { code: 'AUTH_FAILED'; message: string; hint: string }
  | { code: 'VALIDATION_ERROR'; field: string; message: string }
  | { code: 'RATE_LIMITED'; retry_after_ms: number }
  | { code: 'NETWORK_ERROR'; message: string; retryable: boolean }
  | { code: 'PLATFORM_ERROR'; platform: string; status: number; body: string }
  | { code: 'FILE_ERROR'; path: string; message: string };
```

Errors go to stderr. Data goes to stdout. This allows clean piping:

```bash
flnx read --platform slack --channel "#ops" --json 2>/dev/null | jq '.text'
```

---

## 8. Testing Strategy

| Layer | Test type | What it covers |
|-------|-----------|----------------|
| Validation | Unit | Every input field constraint, edge cases, injection patterns |
| Adapters | Integration (mocked) | Request/response serialization against recorded Slack API fixtures |
| Transport | Unit | Retry logic, timeout behavior, TLS enforcement |
| Credential manager | Unit | Resolution order, file permission checks, token hint extraction |
| CLI | E2E | Full command execution against a test Slack workspace |
| Security | Fuzz | Random/malicious input to all public interfaces via `bun test --fuzz` |
| Supply chain | CI | `bun audit`, lockfile integrity, SBOM generation |

---

## 9. Build & Distribution

```bash
# Development
bun run src/cli.ts send --platform slack --channel "#test" --text "hello"

# Compile to standalone binary
bun build src/cli.ts --compile --outfile flnx

# The resulting binary is ~30-50MB, zero external dependencies
./flnx send --platform slack --channel "#test" --text "hello"
```

**Distribution targets:**

| Target | Format |
|--------|--------|
| macOS (arm64, x64) | Standalone binary |
| Linux (x64, arm64) | Standalone binary |
| npm | `bunx flnx-messaging` |
| Homebrew | Tap formula |

---

## 10. Extension: Adding a New Platform

Adding Discord, Teams, or Telegram requires only:

1. Create `src/adapters/discord.ts` implementing `PlatformAdapter`
2. Add platform-specific validation rules to `src/validation/discord.ts`
3. Add credential resolution for `FLNX_DISCORD_TOKEN`
4. Add the API hostname to the outbound allowlist
5. Register the adapter in the platform factory

No changes to commands, CLI parsing, audit logging, or security layer. The adapter interface enforces the normalized message contract.

---

## 11. What We Borrowed and Why

### From OpenClaw

| Pattern | How we use it | What we left behind |
|---------|--------------|---------------------|
| Channel adapter normalization | Our `PlatformAdapter` interface normalizes all platforms to a single contract | OpenClaw's is bidirectional (listen + send); ours is unidirectional by design |
| Per-channel access controls | Our config supports per-channel rate limits and default channels | OpenClaw's mention gating, sender allowlists, and per-channel skills — overkill for a CLI tool |
| Token model separation | We separate credentials per platform with scope tracking | OpenClaw's multi-account model with bot/app/user token hierarchy — unnecessary for single-user CLI |
| Structured audit logging | Every operation logged with redacted credentials | OpenClaw's JSONL transcripts — designed for agent memory, not CLI debugging |
| Content as untrusted | `_flnx_untrusted` flag on inbound messages | OpenClaw's full prompt injection defense stack — they need it because they have an agent loop; we don't |

### From OWASP

| Framework | What we applied |
|-----------|----------------|
| **API Security Top 10 (2023)** | Input validation (API8), rate limiting (API4), auth hardening (API2), scope minimization |
| **Top 10 2025** | Broken access control (A01) → outbound allowlist. Crypto failures (A02) → TLS-only. Supply chain (A03) → zero deps, SBOM. Injection (A03) → input sanitization. Logging (A09) → structured audit with redaction. |
| **Agentic Top 10 (2026)** | Least agency (core principle) → tool does minimum, never interprets content. Goal hijack (ASI01) → untrusted content flagging. Tool misuse (ASI04) → scope validation, excess scope warnings. |
| **MCP Top 10 (2025)** | Token mismanagement (MCP01) → no tokens in logs, no hardcoding, memory-safe lifecycle, credential file permission enforcement. |
| **REST Security Cheat Sheet** | HTTPS-only endpoints, no technical details in error responses, audit logging before/after security events, log injection prevention. |

---

## 12. What This Is Not

flnx-messaging is deliberately **not**:

- **An agent.** It does not listen for messages, make decisions, or take autonomous action. It is invoked, executes, and exits.
- **A daemon.** No background process, no Socket Mode WebSocket, no event subscription.
- **An MCP server.** It is a CLI tool, not a Model Context Protocol server. If you need MCP, use the Slack MCP connector directly.
- **A framework.** It is an opinionated, compiled binary. Not a library you import.

This constraint is the primary security feature. By refusing to be an agent, we eliminate the entire attack surface described in OWASP's Agentic Top 10 — goal hijacking, cascading failures, rogue agent behavior, identity impersonation — none of these apply to a stateless CLI tool that runs and exits.

---

## Appendix A: OWASP Compliance Checklist

| OWASP Item | Status | Notes |
|------------|--------|-------|
| A01:2025 Broken Access Control | ✅ | Outbound allowlist, no redirect following, credential file perms |
| A02:2025 Cryptographic Failures | ✅ | TLS-only, no cert bypass, no custom crypto |
| A03:2025 Supply Chain | ✅ | Zero runtime deps, lockfile, SBOM, signed binaries |
| A04:2025 Injection | ✅ | Input validation on all fields, no shell execution, log sanitization |
| A07:2025 Auth Failures | ✅ | Scope minimization, token validation on first use, rotation support |
| A09:2025 Logging Failures | ✅ | Structured audit log, credential redaction, no content logging |
| API4:2023 Rate Limiting | ✅ | Client-side token bucket + respects server Retry-After |
| MCP01:2025 Token Mismanagement | ✅ | No hardcoding, no log exposure, memory-safe lifecycle |
| ASI01:2026 Goal Hijack | ✅ | Not an agent — no goals to hijack. Untrusted flags on inbound content |
| ASI04:2026 Tool Misuse | ✅ | Scope warnings, minimal permissions, no autonomous tool chaining |

---

## Appendix B: flnx-messaging vs OpenClaw

| Dimension | flnx-messaging | OpenClaw (Slack channel) |
|---|---|---|
| **Philosophy** | Stateless CLI pipe — run, execute, exit | Persistent autonomous AI agent |
| **Runtime** | Bun (compiled to single binary, ~30-50MB) | Node.js daemon (gateway process, ~200+ npm packages) |
| **Dependencies** | 0 runtime deps (Bun built-ins only) | Full npm ecosystem: `@slack/bolt`, `ws`, `express`, `zod`, etc. |
| **Connection model** | One HTTP request per invocation. No persistent state. | Long-lived WebSocket (Socket Mode) or HTTP Events API webhook |
| **Security model** | Defense-in-depth, OWASP-aligned, minimal attack surface | Full agent security stack: sandboxing, tool policies, approval gates, Lane Queue |
| **Auth** | Single scoped bot token per platform, file perms, scope validation | Multi-token hierarchy: bot + app + user tokens, signing secrets, per-account config |
| **Session management** | None — stateless by design | Complex: main/group/isolated sessions, thread scoping, DM pairing |
| **Multi-platform** | Adapter interface (Slack first, Discord/Teams/Telegram planned) | 20+ platforms via channel adapters (WhatsApp, Telegram, Discord, Slack, Signal, etc.) |
| **Agent integration** | Designed as a *tool for* agents (untrusted flags, JSON output, exit codes) | *Is* the agent (LLM orchestration, tool execution, memory, skills) |
| **Inbound messages** | Read-only, tagged `_flnx_untrusted`, no interpretation | Fully processed: routed to agent, triggers LLM inference, may execute tools |
| **Prompt injection defense** | Not applicable — doesn't interpret content | Required — agent loop means every inbound message is a potential injection vector |
| **Maintenance burden** | Low (stateless, zero deps, no daemon management) | High (gateway process, platform SDK updates, session state, config complexity) |
| **Attack surface** | Minimal: CLI process runs 0.5-2s and exits | Large: persistent process with WebSocket, HTTP, file system access, shell execution, browser control |
| **When to use** | AI coding agents (Claude Code, Codex) need to push/pull messages | You want a 24/7 autonomous AI assistant living in your messaging platforms |
| **When NOT to use** | You need real-time event listening, proactive behavior, or autonomous workflows | You just need to send a deploy notification from a CI pipeline |
