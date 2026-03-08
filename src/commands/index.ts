// ─── Command Handlers ──────────────────────────────────────────────────────
// Each command: validate input → call adapter → audit → format output.
// See: architecture doc §3.2

import type { PlatformAdapter } from "../adapters/adapter.js";
import {
  type FlnxError,
  type Message,
  exitCodeForError,
} from "../types/index.js";
import {
  validateChannel,
  validateMessageText,
  validateEmoji,
  validateTimestamp,
  validateLimit,
  validateFilePath,
} from "../validation/index.js";
import { audit, buildAuditEntry } from "../audit/index.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export type OutputFormat = "text" | "json";

interface CommandResult {
  exitCode: number;
  output: string;
}

// ─── Send ──────────────────────────────────────────────────────────────────

export async function handleSend(
  adapter: PlatformAdapter,
  params: { channel: string; text: string; threadId?: string; token?: string },
  format: OutputFormat
): Promise<CommandResult> {
  const startMs = performance.now();

  // Validate
  const channelResult = validateChannel(params.channel);
  if (!channelResult.ok) return errorResult(channelResult.error, format);

  const textResult = validateMessageText(params.text);
  if (!textResult.ok) return errorResult(textResult.error, format);

  // Execute
  const result = await adapter.send({
    channel: channelResult.value,
    text: textResult.value,
    threadId: params.threadId,
  });

  // Audit
  audit(buildAuditEntry("send", adapter.platform, {
    channel: params.channel,
    token: params.token,
    startMs,
    error: result.ok ? undefined : result.error.code,
  }));

  if (!result.ok) return errorResult(result.error, format);

  const data = result.value;
  if (format === "json") {
    return { exitCode: 0, output: JSON.stringify({ ok: true, channelId: data.channelId, timestamp: data.timestamp, threadId: data.threadId }) };
  }
  return { exitCode: 0, output: `Sent to ${data.channelId} (ts: ${data.timestamp})` };
}

// ─── Read ──────────────────────────────────────────────────────────────────

export async function handleRead(
  adapter: PlatformAdapter,
  params: { channel: string; limit: string; threadId?: string; token?: string },
  format: OutputFormat
): Promise<CommandResult> {
  const startMs = performance.now();

  const channelResult = validateChannel(params.channel);
  if (!channelResult.ok) return errorResult(channelResult.error, format);

  const limitResult = validateLimit(params.limit);
  if (!limitResult.ok) return errorResult(limitResult.error, format);

  const result = await adapter.read({
    channel: channelResult.value,
    limit: limitResult.value,
    threadId: params.threadId,
  });

  audit(buildAuditEntry("read", adapter.platform, {
    channel: params.channel,
    token: params.token,
    startMs,
    error: result.ok ? undefined : result.error.code,
  }));

  if (!result.ok) return errorResult(result.error, format);

  const { messages, hasMore } = result.value;

  if (format === "json") {
    const lines = messages.map((m) => JSON.stringify(messageToJson(m)));
    return { exitCode: 0, output: lines.join("\n") };
  }

  if (messages.length === 0) {
    return { exitCode: 0, output: "No messages found." };
  }

  const lines = messages.map((m) => formatMessage(m));
  if (hasMore) lines.push(`\n... more messages available (use --limit to increase)`);
  return { exitCode: 0, output: lines.join("\n\n") };
}

// ─── React ─────────────────────────────────────────────────────────────────

export async function handleReact(
  adapter: PlatformAdapter,
  params: { channel: string; timestamp: string; emoji: string; token?: string },
  format: OutputFormat
): Promise<CommandResult> {
  const startMs = performance.now();

  const channelResult = validateChannel(params.channel);
  if (!channelResult.ok) return errorResult(channelResult.error, format);

  const tsResult = validateTimestamp(params.timestamp);
  if (!tsResult.ok) return errorResult(tsResult.error, format);

  const emojiResult = validateEmoji(params.emoji);
  if (!emojiResult.ok) return errorResult(emojiResult.error, format);

  const result = await adapter.react({
    channel: channelResult.value,
    timestamp: tsResult.value,
    emoji: emojiResult.value,
  });

  audit(buildAuditEntry("react", adapter.platform, {
    channel: params.channel,
    token: params.token,
    startMs,
    error: result.ok ? undefined : result.error.code,
  }));

  if (!result.ok) return errorResult(result.error, format);

  if (format === "json") {
    return { exitCode: 0, output: JSON.stringify({ ok: true, emoji: emojiResult.value }) };
  }
  return { exitCode: 0, output: `Reacted with :${emojiResult.value}:` };
}

// ─── Upload ────────────────────────────────────────────────────────────────

export async function handleUpload(
  adapter: PlatformAdapter,
  params: { channel: string; filePath: string; filename?: string; title?: string; threadId?: string; token?: string },
  format: OutputFormat
): Promise<CommandResult> {
  const startMs = performance.now();

  const channelResult = validateChannel(params.channel);
  if (!channelResult.ok) return errorResult(channelResult.error, format);

  const fileResult = await validateFilePath(params.filePath);
  if (!fileResult.ok) return errorResult(fileResult.error, format);

  const result = await adapter.upload({
    channel: channelResult.value,
    filePath: fileResult.value,
    filename: params.filename,
    title: params.title,
    threadId: params.threadId,
  });

  audit(buildAuditEntry("upload", adapter.platform, {
    channel: params.channel,
    token: params.token,
    startMs,
    error: result.ok ? undefined : result.error.code,
  }));

  if (!result.ok) return errorResult(result.error, format);

  const data = result.value;
  if (format === "json") {
    return { exitCode: 0, output: JSON.stringify({ ok: true, fileId: data.fileId, filename: data.filename }) };
  }
  return { exitCode: 0, output: `Uploaded ${data.filename} (file_id: ${data.fileId})` };
}

// ─── Channels ──────────────────────────────────────────────────────────────

export async function handleChannels(
  adapter: PlatformAdapter,
  params: { token?: string },
  format: OutputFormat
): Promise<CommandResult> {
  const startMs = performance.now();

  const result = await adapter.listChannels();

  audit(buildAuditEntry("channels", adapter.platform, {
    token: params.token,
    startMs,
    error: result.ok ? undefined : result.error.code,
  }));

  if (!result.ok) return errorResult(result.error, format);

  const channels = result.value;

  if (format === "json") {
    const lines = channels.map((c) => JSON.stringify(c));
    return { exitCode: 0, output: lines.join("\n") };
  }

  if (channels.length === 0) {
    return { exitCode: 0, output: "No channels found." };
  }

  const lines = channels.map((c) => {
    const lock = c.isPrivate ? "🔒" : "#";
    const members = c.memberCount !== undefined ? ` (${c.memberCount} members)` : "";
    return `${lock} ${c.name}${members}`;
  });
  return { exitCode: 0, output: lines.join("\n") };
}

// ─── Status ────────────────────────────────────────────────────────────────

export async function handleStatus(
  adapter: PlatformAdapter,
  params: { token?: string },
  format: OutputFormat
): Promise<CommandResult> {
  const startMs = performance.now();

  const result = await adapter.healthCheck();

  audit(buildAuditEntry("status", adapter.platform, {
    token: params.token,
    startMs,
    error: result.ok ? undefined : result.error.code,
  }));

  if (!result.ok) return errorResult(result.error, format);

  const health = result.value;

  if (format === "json") {
    return { exitCode: 0, output: JSON.stringify(health) };
  }

  const lines = [
    `Platform: ${health.platform}`,
    `Status: ${health.ok ? "connected" : "error"}`,
    health.userName ? `User: ${health.userName}` : null,
    health.teamName ? `Team: ${health.teamName}` : null,
    `Latency: ${health.latencyMs}ms`,
  ].filter(Boolean);

  return { exitCode: 0, output: lines.join("\n") };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function errorResult(error: FlnxError, format: OutputFormat): CommandResult {
  const exitCode = exitCodeForError(error);
  if (format === "json") {
    return { exitCode, output: JSON.stringify({ ok: false, error }) };
  }
  let msg = `Error [${error.code}]: `;
  if ("message" in error) msg += error.message;
  if ("field" in error) msg += ` (field: ${error.field})`;
  if ("hint" in error) msg += `\n  Hint: ${error.hint}`;
  if ("path" in error) msg += ` (path: ${error.path})`;
  return { exitCode, output: msg };
}

function formatMessage(msg: Message): string {
  const time = msg.timestamp.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
  const sender = msg.senderName || msg.senderId;
  return `[${time}] @${sender} in ${msg.channelId}:\n  ${msg.text}`;
}

function messageToJson(msg: Message): Record<string, unknown> {
  return {
    id: msg.id,
    channel: msg.channelId,
    sender: msg.senderName || msg.senderId,
    text: msg.text,
    timestamp: msg.timestamp.toISOString(),
    threadId: msg.threadId,
    _flnx_untrusted: msg._flnx_untrusted,
    _flnx_source: msg._flnx_source,
  };
}
