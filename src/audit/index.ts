// ─── Audit Logger ──────────────────────────────────────────────────────────
// Structured JSON logging with redacted credentials.
// See: architecture doc §3.7
// OWASP A09:2025 (Logging Failures), MCP01:2025 (Token Mismanagement)

import { tokenHint } from "../credentials/index.js";
import { sanitizeForLog } from "../validation/index.js";
import type { PlatformType } from "../types/index.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface AuditEntry {
  timestamp: string;
  command: string;
  platform: PlatformType;
  channel?: string;
  status: "success" | "error";
  latencyMs?: number;
  tokenHint?: string;
  error?: string;
}

export type AuditSink = (entry: AuditEntry) => void;

interface AuditConfig {
  enabled?: boolean;
  sink?: AuditSink;
}

// ─── State ─────────────────────────────────────────────────────────────────

let auditEnabled = true;
let auditSink: AuditSink = defaultSink;

// ─── Public API ────────────────────────────────────────────────────────────

/** Configure audit logging behavior. */
export function configureAudit(config: AuditConfig): void {
  if (config.enabled !== undefined) auditEnabled = config.enabled;
  if (config.sink) auditSink = config.sink;
}

/** Create a file-based audit sink. */
export function createFileSink(filePath: string): AuditSink {
  return (entry: AuditEntry) => {
    const line = JSON.stringify(entry) + "\n";
    // Append to file — fire-and-forget, audit should never block operations
    Bun.write(filePath, line, { append: true }).catch(() => {
      // If file write fails, fall back to stderr
      process.stderr.write(line);
    });
  };
}

/** Log an audit entry. */
export function audit(entry: AuditEntry): void {
  if (!auditEnabled) return;

  // Sanitize any user-provided strings in the entry
  if (entry.channel) {
    entry.channel = sanitizeForLog(entry.channel);
  }
  if (entry.error) {
    entry.error = sanitizeForLog(entry.error);
  }

  auditSink(entry);
}

/** Build an audit entry for a command execution. */
export function buildAuditEntry(
  command: string,
  platform: PlatformType,
  opts: {
    channel?: string;
    token?: string;
    startMs?: number;
    error?: string;
  }
): AuditEntry {
  return {
    timestamp: new Date().toISOString(),
    command,
    platform,
    channel: opts.channel,
    status: opts.error ? "error" : "success",
    latencyMs: opts.startMs ? Math.round(performance.now() - opts.startMs) : undefined,
    tokenHint: opts.token ? tokenHint(opts.token) : undefined,
    error: opts.error,
  };
}

// ─── Private ───────────────────────────────────────────────────────────────

function defaultSink(entry: AuditEntry): void {
  process.stderr.write(JSON.stringify(entry) + "\n");
}
