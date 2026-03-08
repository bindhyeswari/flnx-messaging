## Workflow Rules

- **Check permissions before asking.** Before prompting the user for tool access, read `.claude/settings.local.json` to verify whether the permission is already granted. Never ask for access that is already configured. This is a remote session — the user cannot approve interactive prompts mid-run.

# flnx-messaging

Stateless CLI tool for sending/reading/reacting to messages across platforms (Slack first, Discord/Teams/Telegram planned).

## Current Status

See `TASKS.md` for the full task list. Phase 1 (scaffold + core infrastructure) and Phase 2 (command handlers + audit) are complete. Next up: Phase 3 (testing & hardening).

## Tech Stack

- **Runtime:** Bun (compiled to single binary)
- **Language:** TypeScript (strict mode)
- **Dependencies:** Zero runtime npm deps — uses Bun built-ins (`fetch`, `crypto`)
- **Version:** 0.1.0

## Project Structure

```
src/
  cli.ts              — CLI entry point: arg parsing, command routing, credential management
  types/index.ts      — Core types: Message, Channel, Result<T,E>, FlnxError, exit codes
  adapters/adapter.ts — PlatformAdapter interface + adapter factory (createAdapter)
  adapters/slack.ts   — SlackAdapter implementation (all Slack Web API calls)
  transport/index.ts  — secureRequest: TLS-only, retry, timeout, host allowlist, response cap
  validation/index.ts — Input validators for all fields + log sanitization
  credentials/index.ts— Token resolution (flag→env→file), 0600 credential storage
  commands/index.ts   — Command handlers (send, read, react, upload, channels, status)
  audit/index.ts      — Structured JSON audit logging with credential redaction
```

**Legacy root files** (`index.ts`, `adapter.ts`, `slack.ts`, `cli.ts`) are the original drafts — canonical code is now under `src/`.

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
bun run src/cli.ts <command> [options]
bun build src/cli.ts --compile --outfile flnx
```

## Security Notes

- Never log full tokens — only last 4 chars (`token_hint`)
- All inbound message content carries `_flnx_untrusted: true`
- Credential file must be mode 0600
- Outbound requests: HTTPS only, no redirects, host allowlist
- See `flnx-messaging-architecture.md` for full threat model and OWASP mapping
