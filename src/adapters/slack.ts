import type {
  PlatformAdapter,
} from "./adapter.js";
import { REQUIRED_SCOPES } from "./adapter.js";
import {
  type Result,
  type FlnxError,
  type SendParams,
  type SendResult,
  type ReadParams,
  type ReadResult,
  type ReactParams,
  type UploadParams,
  type UploadResult,
  type Channel,
  type HealthStatus,
  type Message,
  Ok,
  Err,
} from "../types/index.js";
import { secureRequest } from "../transport/index.js";

// ─── Constants ─────────────────────────────────────────────────────────────

const SLACK_API = "https://slack.com/api";

// ─── Slack Adapter ─────────────────────────────────────────────────────────

export class SlackAdapter implements PlatformAdapter {
  readonly platform = "slack" as const;
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  // ── Send ─────────────────────────────────────────────────────────────────

  async send(params: SendParams): Promise<Result<SendResult, FlnxError>> {
    const body: Record<string, unknown> = {
      channel: params.channel,
      text: params.text,
    };
    if (params.threadId) {
      body.thread_ts = params.threadId;
    }

    const result = await this.apiCall("chat.postMessage", body);
    if (!result.ok) return result;

    const data = result.value as { ok: boolean; ts: string; channel: string; error?: string };
    if (!data.ok) {
      return Err(this.slackError("chat.postMessage", data.error));
    }

    return Ok({
      ok: true,
      channelId: data.channel,
      timestamp: data.ts,
      threadId: params.threadId,
    });
  }

  // ── Read ─────────────────────────────────────────────────────────────────

  async read(params: ReadParams): Promise<Result<ReadResult, FlnxError>> {
    const body: Record<string, unknown> = {
      channel: params.channel,
      limit: params.limit,
    };
    if (params.threadId) {
      body.ts = params.threadId;
    }
    if (params.before) body.latest = params.before;
    if (params.after) body.oldest = params.after;

    const method = params.threadId ? "conversations.replies" : "conversations.history";
    const result = await this.apiCall(method, body);
    if (!result.ok) return result;

    const data = result.value as {
      ok: boolean;
      messages: SlackMessage[];
      has_more: boolean;
      response_metadata?: { next_cursor?: string };
      error?: string;
    };
    if (!data.ok) {
      return Err(this.slackError(method, data.error));
    }

    const messages: Message[] = (data.messages || []).map((m) =>
      this.normalizeMessage(m, params.channel)
    );

    return Ok({
      messages,
      hasMore: data.has_more || false,
      cursor: data.response_metadata?.next_cursor,
    });
  }

  // ── React ────────────────────────────────────────────────────────────────

  async react(params: ReactParams): Promise<Result<void, FlnxError>> {
    const result = await this.apiCall("reactions.add", {
      channel: params.channel,
      timestamp: params.timestamp,
      name: params.emoji,
    });
    if (!result.ok) return result;

    const data = result.value as { ok: boolean; error?: string };
    if (!data.ok) {
      if (data.error === "already_reacted") return Ok(undefined);
      return Err(this.slackError("reactions.add", data.error));
    }

    return Ok(undefined);
  }

  // ── Upload ───────────────────────────────────────────────────────────────

  async upload(params: UploadParams): Promise<Result<UploadResult, FlnxError>> {
    const file = Bun.file(params.filePath);
    const filename = params.filename || params.filePath.split("/").pop() || "file";
    const fileSize = file.size;

    // Step 1: Get upload URL
    const urlResult = await this.apiCall("files.getUploadURLExternal", {
      filename,
      length: fileSize,
    });
    if (!urlResult.ok) return urlResult;

    const urlData = urlResult.value as {
      ok: boolean;
      upload_url: string;
      file_id: string;
      error?: string;
    };
    if (!urlData.ok) {
      return Err(this.slackError("files.getUploadURLExternal", urlData.error));
    }

    // Step 2: Upload the file to the provided URL
    const fileContent = await file.arrayBuffer();
    const uploadResult = await secureRequest(urlData.upload_url, {
      method: "POST",
      body: fileContent,
      headers: { "Content-Type": "application/octet-stream" },
    });
    if (!uploadResult.ok) return uploadResult;

    // Step 3: Complete the upload
    const completeResult = await this.apiCall("files.completeUploadExternal", {
      files: [{ id: urlData.file_id, title: params.title || filename }],
      channel_id: params.channel,
      thread_ts: params.threadId,
    });
    if (!completeResult.ok) return completeResult;

    const completeData = completeResult.value as { ok: boolean; error?: string };
    if (!completeData.ok) {
      return Err(this.slackError("files.completeUploadExternal", completeData.error));
    }

    return Ok({
      ok: true,
      fileId: urlData.file_id,
      filename,
    });
  }

  // ── List Channels ────────────────────────────────────────────────────────

  async listChannels(): Promise<Result<Channel[], FlnxError>> {
    const result = await this.apiCall("conversations.list", {
      types: "public_channel,private_channel",
      limit: 200,
      exclude_archived: true,
    });
    if (!result.ok) return result;

    const data = result.value as {
      ok: boolean;
      channels: SlackChannel[];
      error?: string;
    };
    if (!data.ok) {
      return Err(this.slackError("conversations.list", data.error));
    }

    const channels: Channel[] = (data.channels || []).map((c) => ({
      id: c.id,
      name: c.name,
      platform: "slack" as const,
      isPrivate: c.is_private || false,
      memberCount: c.num_members,
    }));

    return Ok(channels);
  }

  // ── Health Check ─────────────────────────────────────────────────────────

  async healthCheck(): Promise<Result<HealthStatus, FlnxError>> {
    const startMs = performance.now();

    const result = await this.apiCall("auth.test", {});
    if (!result.ok) return result;

    const data = result.value as {
      ok: boolean;
      user_id: string;
      user: string;
      team: string;
      error?: string;
    };
    if (!data.ok) {
      return Err(this.slackError("auth.test", data.error));
    }

    const latencyMs = Math.round(performance.now() - startMs);

    return Ok({
      platform: "slack",
      ok: true,
      userId: data.user_id,
      userName: data.user,
      teamName: data.team,
      latencyMs,
    });
  }

  // ── Private: API Call ────────────────────────────────────────────────────

  private async apiCall(
    method: string,
    body: Record<string, unknown>
  ): Promise<Result<unknown, FlnxError>> {
    const url = `${SLACK_API}/${method}`;

    const result = await secureRequest(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });

    if (!result.ok) return result;

    const data = result.value.body;

    if (result.value.status === 401 || (data as any)?.error === "invalid_auth") {
      return Err({
        code: "AUTH_FAILED",
        message: "Slack rejected the token. It may be expired or revoked.",
        hint: "Check your FLNX_SLACK_TOKEN or run: flnx credential set --platform slack",
      });
    }
    if ((data as any)?.error === "missing_scope") {
      return Err({
        code: "AUTH_FAILED",
        message: `Token is missing required scope for ${method}. Needed: ${(data as any)?.needed}`,
        hint: "Reinstall the Slack app with the required scopes.",
      });
    }

    return Ok(data);
  }

  // ── Private: Normalize ───────────────────────────────────────────────────

  private normalizeMessage(msg: SlackMessage, channelId: string): Message {
    return {
      id: msg.ts,
      platform: "slack",
      channelId,
      senderId: msg.user || msg.bot_id || "unknown",
      senderName: msg.username,
      text: msg.text || "",
      timestamp: new Date(parseFloat(msg.ts) * 1000),
      threadId: msg.thread_ts,
      attachments: (msg.files || []).map((f) => ({
        id: f.id,
        filename: f.name || "unknown",
        mimeType: f.mimetype || "application/octet-stream",
        url: f.url_private || "",
        sizeBytes: f.size,
      })),
      _flnx_untrusted: true,
      _flnx_source: "slack",
    };
  }

  private slackError(method: string, error?: string): FlnxError {
    return {
      code: "PLATFORM_ERROR",
      platform: "slack",
      status: 200,
      body: `${method}: ${error || "unknown error"}`,
    };
  }
}

// ─── Slack API Types (internal) ────────────────────────────────────────────

interface SlackMessage {
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  thread_ts?: string;
  files?: SlackFile[];
}

interface SlackFile {
  id: string;
  name?: string;
  mimetype?: string;
  url_private?: string;
  size?: number;
}

interface SlackChannel {
  id: string;
  name: string;
  is_private?: boolean;
  num_members?: number;
}
