// ─── Result Type (no external deps) ────────────────────────────────────────

export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export const Ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const Err = <E>(error: E): Result<never, E> => ({ ok: false, error });

// ─── Platform ──────────────────────────────────────────────────────────────

export const PLATFORMS = ["slack", "discord", "teams", "telegram"] as const;
export type PlatformType = (typeof PLATFORMS)[number];

// ─── Normalized Message Envelope ───────────────────────────────────────────
// Platform-agnostic representation. All adapters produce this shape.
// Inbound messages are always tagged _flnx_untrusted to signal downstream
// consumers (especially AI agents) that content should not be interpreted
// as instructions. See: OWASP ASI01:2026 (Agent Goal Hijack).

export interface Message {
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
  /** Always true for inbound messages. Signals untrusted content. */
  _flnx_untrusted: true;
  _flnx_source: PlatformType;
}

export interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  url: string;
  sizeBytes?: number;
}

export interface Channel {
  id: string;
  name: string;
  platform: PlatformType;
  isPrivate: boolean;
  memberCount?: number;
}

export interface HealthStatus {
  platform: PlatformType;
  ok: boolean;
  userId?: string;
  userName?: string;
  teamName?: string;
  scopes?: string[];
  latencyMs: number;
}

// ─── Command Parameters ────────────────────────────────────────────────────

export interface SendParams {
  channel: string;
  text: string;
  threadId?: string;
}

export interface ReadParams {
  channel: string;
  limit: number;
  threadId?: string;
  before?: string;
  after?: string;
}

export interface ReactParams {
  channel: string;
  timestamp: string;
  emoji: string;
}

export interface UploadParams {
  channel: string;
  filePath: string;
  filename?: string;
  title?: string;
  threadId?: string;
}

// ─── Command Results ───────────────────────────────────────────────────────

export interface SendResult {
  ok: true;
  channelId: string;
  timestamp: string;
  threadId?: string;
}

export interface ReadResult {
  messages: Message[];
  hasMore: boolean;
  cursor?: string;
}

export interface UploadResult {
  ok: true;
  fileId: string;
  filename: string;
}

// ─── Errors ────────────────────────────────────────────────────────────────

export type FlnxError =
  | { code: "AUTH_FAILED"; message: string; hint: string }
  | { code: "VALIDATION_ERROR"; field: string; message: string }
  | { code: "RATE_LIMITED"; retryAfterMs: number }
  | { code: "NETWORK_ERROR"; message: string; retryable: boolean }
  | { code: "PLATFORM_ERROR"; platform: PlatformType; status: number; body: string }
  | { code: "FILE_ERROR"; path: string; message: string }
  | { code: "CONFIG_ERROR"; message: string };

// ─── Exit Codes ────────────────────────────────────────────────────────────

export const EXIT = {
  SUCCESS: 0,
  GENERAL_ERROR: 1,
  AUTH_ERROR: 2,
  VALIDATION_ERROR: 3,
  RATE_LIMITED: 4,
  NETWORK_ERROR: 5,
} as const;

export function exitCodeForError(err: FlnxError): number {
  switch (err.code) {
    case "AUTH_FAILED": return EXIT.AUTH_ERROR;
    case "VALIDATION_ERROR": return EXIT.VALIDATION_ERROR;
    case "RATE_LIMITED": return EXIT.RATE_LIMITED;
    case "NETWORK_ERROR": return EXIT.NETWORK_ERROR;
    default: return EXIT.GENERAL_ERROR;
  }
}
