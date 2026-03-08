// ─── Input Validation Layer ────────────────────────────────────────────────
// All input is validated before reaching any platform adapter.
// See: architecture doc §3.3, §4.2
// OWASP A03:2025 (Injection), API8:2023 (Security Misconfiguration)

import {
  type Result,
  type FlnxError,
  type PlatformType,
  PLATFORMS,
  Ok,
  Err,
} from "../types/index.js";

// ─── Constants ─────────────────────────────────────────────────────────────

const MAX_TEXT_LENGTH = 40_000; // Slack limit
const MAX_CHANNEL_LENGTH = 80;
const MAX_EMOJI_LENGTH = 100;
const MAX_LIMIT = 1_000;
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

// ─── Patterns ──────────────────────────────────────────────────────────────

/** Channel name: #channel, @user, or plain name */
const CHANNEL_NAME_RE = /^[#@]?[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

/** Slack channel ID: starts with C, D, G, or W followed by alphanumeric */
const CHANNEL_ID_RE = /^[CDGW][A-Z0-9]{8,}$/;

/** Emoji shortcode: lowercase alphanumeric with underscores, hyphens, plus */
const EMOJI_RE = /^[a-z0-9_+\-]{1,100}$/;

/** Slack timestamp: 10 digits, dot, 1-6 digits */
const TIMESTAMP_RE = /^\d{10}\.\d{1,6}$/;

/** Control characters (except newline \n and tab \t) */
const CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;

// ─── Validators ────────────────────────────────────────────────────────────

export function validatePlatform(input: string): Result<PlatformType, FlnxError> {
  const lower = input.toLowerCase().trim();
  if (PLATFORMS.includes(lower as PlatformType)) {
    return Ok(lower as PlatformType);
  }
  return Err({
    code: "VALIDATION_ERROR",
    field: "platform",
    message: `Invalid platform "${input}". Supported: ${PLATFORMS.join(", ")}`,
  });
}

export function validateChannel(input: string): Result<string, FlnxError> {
  const trimmed = input.trim();
  if (!trimmed) {
    return Err({
      code: "VALIDATION_ERROR",
      field: "channel",
      message: "Channel cannot be empty",
    });
  }

  // Accept Slack channel IDs directly
  if (CHANNEL_ID_RE.test(trimmed)) {
    return Ok(trimmed);
  }

  // Validate channel name format
  if (!CHANNEL_NAME_RE.test(trimmed)) {
    return Err({
      code: "VALIDATION_ERROR",
      field: "channel",
      message: `Invalid channel format: "${trimmed}". Use #channel-name, @username, or a channel ID (C01234ABCDE)`,
    });
  }

  if (trimmed.length > MAX_CHANNEL_LENGTH) {
    return Err({
      code: "VALIDATION_ERROR",
      field: "channel",
      message: `Channel name exceeds ${MAX_CHANNEL_LENGTH} character limit`,
    });
  }

  return Ok(trimmed);
}

export function validateMessageText(text: string): Result<string, FlnxError> {
  if (text.length === 0) {
    return Err({
      code: "VALIDATION_ERROR",
      field: "text",
      message: "Message text cannot be empty",
    });
  }

  if (text.length > MAX_TEXT_LENGTH) {
    return Err({
      code: "VALIDATION_ERROR",
      field: "text",
      message: `Message exceeds ${MAX_TEXT_LENGTH} character limit (got ${text.length})`,
    });
  }

  if (/\x00/.test(text)) {
    return Err({
      code: "VALIDATION_ERROR",
      field: "text",
      message: "Message contains null bytes",
    });
  }

  if (CONTROL_CHARS_RE.test(text)) {
    return Err({
      code: "VALIDATION_ERROR",
      field: "text",
      message: "Message contains disallowed control characters",
    });
  }

  return Ok(text);
}

export function validateEmoji(emoji: string): Result<string, FlnxError> {
  const trimmed = emoji.trim().replace(/^:/, "").replace(/:$/, "");

  if (!trimmed) {
    return Err({
      code: "VALIDATION_ERROR",
      field: "emoji",
      message: "Emoji cannot be empty",
    });
  }

  if (!EMOJI_RE.test(trimmed)) {
    return Err({
      code: "VALIDATION_ERROR",
      field: "emoji",
      message: `Invalid emoji shortcode: "${emoji}". Use lowercase with underscores (e.g., white_check_mark)`,
    });
  }

  return Ok(trimmed);
}

export function validateTimestamp(ts: string): Result<string, FlnxError> {
  const trimmed = ts.trim();

  if (!TIMESTAMP_RE.test(trimmed)) {
    return Err({
      code: "VALIDATION_ERROR",
      field: "timestamp",
      message: `Invalid message timestamp: "${ts}". Expected format: 1712023032.123456`,
    });
  }

  return Ok(trimmed);
}

export function validateLimit(input: string | number): Result<number, FlnxError> {
  const num = typeof input === "string" ? parseInt(input, 10) : input;

  if (isNaN(num) || !Number.isInteger(num)) {
    return Err({
      code: "VALIDATION_ERROR",
      field: "limit",
      message: `Invalid limit: "${input}". Must be an integer`,
    });
  }

  if (num < 1 || num > MAX_LIMIT) {
    return Err({
      code: "VALIDATION_ERROR",
      field: "limit",
      message: `Limit must be between 1 and ${MAX_LIMIT} (got ${num})`,
    });
  }

  return Ok(num);
}

export async function validateFilePath(filePath: string): Promise<Result<string, FlnxError>> {
  try {
    const file = Bun.file(filePath);
    const exists = await file.exists();

    if (!exists) {
      return Err({
        code: "FILE_ERROR",
        path: filePath,
        message: `File not found: ${filePath}`,
      });
    }

    if (file.size > MAX_FILE_SIZE) {
      return Err({
        code: "FILE_ERROR",
        path: filePath,
        message: `File exceeds ${MAX_FILE_SIZE / (1024 * 1024)}MB limit (${Math.round(file.size / (1024 * 1024))}MB)`,
      });
    }

    return Ok(filePath);
  } catch (err) {
    return Err({
      code: "FILE_ERROR",
      path: filePath,
      message: `Cannot access file: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

// ─── Log Sanitization ──────────────────────────────────────────────────────

/** Strip control chars, escape newlines, truncate — safe for structured logs. */
export function sanitizeForLog(input: string): string {
  return input
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .replace(/\n/g, "\\n")
    .slice(0, 200);
}
