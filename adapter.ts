import type {
  Result,
  FlnxError,
  PlatformType,
  SendParams,
  SendResult,
  ReadParams,
  ReadResult,
  ReactParams,
  UploadParams,
  UploadResult,
  Channel,
  HealthStatus,
} from "../types/index.js";

// ─── Adapter Interface ─────────────────────────────────────────────────────
// Borrowed from OpenClaw's channel adapter pattern, but simplified:
// - Unidirectional (no event listening, no WebSocket, no session management)
// - Stateless (no connection pool, no daemon, no background threads)
// - Each method is a single HTTP request-response cycle

export interface PlatformAdapter {
  readonly platform: PlatformType;

  /** Send a message to a channel or DM. */
  send(params: SendParams): Promise<Result<SendResult, FlnxError>>;

  /** Read recent messages from a channel. */
  read(params: ReadParams): Promise<Result<ReadResult, FlnxError>>;

  /** Add an emoji reaction to a message. */
  react(params: ReactParams): Promise<Result<void, FlnxError>>;

  /** Upload a file to a channel (uses current API surface, not deprecated methods). */
  upload(params: UploadParams): Promise<Result<UploadResult, FlnxError>>;

  /** List accessible channels. */
  listChannels(): Promise<Result<Channel[], FlnxError>>;

  /**
   * Verify token validity and return workspace info.
   * Also checks that the token's scopes match what flnx needs.
   * OWASP ASI04:2026 — warn on over-provisioned tokens.
   */
  healthCheck(): Promise<Result<HealthStatus, FlnxError>>;
}

// ─── Required Scopes ───────────────────────────────────────────────────────
// Minimum scopes flnx-messaging needs per platform. Used by healthCheck()
// to warn if a token has more access than necessary.

export const REQUIRED_SCOPES: Record<PlatformType, string[]> = {
  slack: [
    "chat:write",
    "channels:read",
    "channels:history",
    "groups:history",
    "im:history",
    "reactions:write",
    "files:read",
    "files:write",
  ],
  discord: [], // TBD
  teams: [],   // TBD
  telegram: [], // TBD
};

// ─── Adapter Factory ───────────────────────────────────────────────────────

import { SlackAdapter } from "./slack.js";

const ADAPTER_CONSTRUCTORS: Partial<Record<PlatformType, new (token: string) => PlatformAdapter>> = {
  slack: SlackAdapter,
};

export function createAdapter(platform: PlatformType, token: string): PlatformAdapter {
  const Constructor = ADAPTER_CONSTRUCTORS[platform];
  if (!Constructor) {
    throw new Error(
      `Platform "${platform}" is not yet implemented. Supported: ${Object.keys(ADAPTER_CONSTRUCTORS).join(", ")}`
    );
  }
  return new Constructor(token);
}
