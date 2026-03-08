# Tasks

## Phase 1: Scaffold & Core Infrastructure

- [x] Scaffold `src/` directory structure and move existing files
- [x] Build transport layer (`src/transport/`) — `secureRequest` with TLS-only, retry, timeout
- [x] Build validation layer (`src/validation/`) — input sanitization for all fields
- [x] Build credential manager (`src/credentials/`) — token resolution, 0600 file storage

## Phase 2: Command Handlers

- [x] Build command handlers (`src/commands/`) — `handleSend`, `handleRead`, `handleReact`, `handleUpload`, `handleChannels`, `handleStatus`
- [x] Build audit logger (`src/audit/`) — structured JSON logging with redacted credentials

## Phase 3: Testing & Hardening

- [ ] Unit tests for validation layer
- [ ] Unit tests for transport (retry, timeout, TLS enforcement)
- [ ] Integration tests for Slack adapter with recorded API fixtures
- [ ] E2E CLI tests

## Phase 4: Build & Distribution

- [ ] `package.json` and `bun.lock` setup
- [ ] Compile to standalone binary
- [ ] CI pipeline
