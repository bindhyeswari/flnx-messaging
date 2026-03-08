# flnx-messaging

Stateless CLI tool for sending/reading/reacting to messages across platforms (Slack first, Discord/Teams/Telegram planned).

## Current Status

See `TASKS.md` for the full task list. Next up: scaffold the `src/` directory and build the transport layer (`secureRequest`), which is the critical dependency blocking everything else.

## Tech Stack

- **Runtime:** Bun (compiled to single binary)
- **Language:** TypeScript (strict mode)
- **Dependencies:** Zero runtime npm deps — uses Bun built-ins (`fetch`, `crypto`)
- **Version:** 0.1.0

## Project Structure

```
index.ts          — Core types: Message, Channel, Result<T,E>, FlnxError, exit codes
adapter.ts        — PlatformAdapter interface + adapter factory (createAdapter)
slack.ts          — SlackAdapter implementation (all Slack Web API calls)
cli.ts            — CLI entry point: arg parsing, command routing, credential management
```

**Planned (referenced in cli.ts imports but not yet created):**
- `src/validation/` — Input validation layer
- `src/credentials/` — Token resolution and storage
- `src/commands/` — Command handlers (send, read, react, upload, channels, status)
- `src/transport/` — HTTP transport (TLS-only, retry, timeout)
- `src/audit/` — Structured JSON audit logging

## Architecture

- **Stateless:** Each invocation = one HTTP request-response cycle. No daemon, no WebSocket.
- **Adapter pattern:** `PlatformAdapter` interface normalizes all platforms. Only Slack implemented so far.
- **Result type:** All operations return `Result<T, FlnxError>` — no thrown exceptions in business logic.
- **Security-first:** OWASP-aligned. Inbound messages tagged `_flnx_untrusted`. Tokens never logged. TLS-only transport.

## Key Patterns

- `Ok()` / `Err()` for Result construction
- Slack API always returns HTTP 200 — errors are in the response body (`data.ok === false`)
- File uploads use the two-step flow: `files.getUploadURLExternal` + `files.completeUploadExternal`
- Credential resolution: `--token` flag → env var (`FLNX_SLACK_TOKEN`) → credential file → keychain
- Exit codes: 0=success, 1=general, 2=auth, 3=validation, 4=rate-limit, 5=network

## Commands

```
flnx send --channel "#ops" --text "message"
flnx read --channel "#ops" --limit 10 --json
flnx react --channel "#ops" --ts 1712023032.1234 --emoji white_check_mark
flnx upload --channel "#ops" --file ./report.pdf
flnx channels
flnx status
flnx credential --set --platform slack --token xoxb-...
```

## Build & Run

```bash
bun run cli.ts <command> [options]
bun build cli.ts --compile --outfile flnx
```

## Security Notes

- Never log full tokens — only last 4 chars (`token_hint`)
- All inbound message content carries `_flnx_untrusted: true`
- Credential file must be mode 0600
- Outbound requests: HTTPS only, no redirects, host allowlist
- See `flnx-messaging-architecture.md` for full threat model and OWASP mapping
