import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { SlackAdapter } from "./slack.js";

// ─── Mock Fetch Setup ────────────────────────────────────────────────────
// Replace global fetch with a mock that returns recorded API fixtures.
// This lets us test the adapter without hitting real Slack APIs.

type MockHandler = (url: string, init: RequestInit) => Response | Promise<Response>;

let originalFetch: typeof globalThis.fetch;
let mockHandler: MockHandler;

function installMock(handler: MockHandler) {
  mockHandler = handler;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return mockHandler(url, init || {});
  }) as typeof fetch;
}

function slackOk(body: Record<string, unknown>) {
  return new Response(JSON.stringify({ ok: true, ...body }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function slackErr(error: string) {
  return new Response(JSON.stringify({ ok: false, error }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ─── send ─────────────────────────────────────────────────────────────────

describe("SlackAdapter.send", () => {
  test("sends a message and returns result", async () => {
    installMock((url, init) => {
      expect(url).toBe("https://slack.com/api/chat.postMessage");
      const body = JSON.parse(init.body as string);
      expect(body.channel).toBe("C01234");
      expect(body.text).toBe("hello");
      return slackOk({ ts: "1712023032.123456", channel: "C01234" });
    });

    const adapter = new SlackAdapter("xoxb-test-token");
    const result = await adapter.send({ channel: "C01234", text: "hello" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.channelId).toBe("C01234");
      expect(result.value.timestamp).toBe("1712023032.123456");
    }
  });

  test("sends with thread_ts when threadId provided", async () => {
    installMock((_url, init) => {
      const body = JSON.parse(init.body as string);
      expect(body.thread_ts).toBe("1712023032.100000");
      return slackOk({ ts: "1712023032.200000", channel: "C01234" });
    });

    const adapter = new SlackAdapter("xoxb-test-token");
    const result = await adapter.send({
      channel: "C01234",
      text: "reply",
      threadId: "1712023032.100000",
    });
    expect(result.ok).toBe(true);
  });

  test("returns error when Slack API reports failure", async () => {
    installMock(() => slackErr("channel_not_found"));

    const adapter = new SlackAdapter("xoxb-test-token");
    const result = await adapter.send({ channel: "C_INVALID", text: "hi" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PLATFORM_ERROR");
    }
  });

  test("includes authorization header", async () => {
    installMock((_url, init) => {
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer xoxb-my-token");
      return slackOk({ ts: "1.1", channel: "C01" });
    });

    const adapter = new SlackAdapter("xoxb-my-token");
    await adapter.send({ channel: "C01", text: "test" });
  });

  test("returns AUTH_FAILED on invalid_auth", async () => {
    installMock(() => slackErr("invalid_auth"));

    const adapter = new SlackAdapter("xoxb-bad-token");
    const result = await adapter.send({ channel: "C01", text: "test" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("AUTH_FAILED");
    }
  });

  test("returns AUTH_FAILED on missing_scope", async () => {
    installMock(() =>
      new Response(
        JSON.stringify({ ok: false, error: "missing_scope", needed: "chat:write" }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const adapter = new SlackAdapter("xoxb-test-token");
    const result = await adapter.send({ channel: "C01", text: "test" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("AUTH_FAILED");
      expect(result.error.message).toContain("missing required scope");
    }
  });
});

// ─── read ─────────────────────────────────────────────────────────────────

describe("SlackAdapter.read", () => {
  test("reads messages from a channel", async () => {
    installMock((url) => {
      expect(url).toBe("https://slack.com/api/conversations.history");
      return slackOk({
        messages: [
          { ts: "1712023032.100000", text: "hello", user: "U01" },
          { ts: "1712023032.200000", text: "world", user: "U02" },
        ],
        has_more: false,
      });
    });

    const adapter = new SlackAdapter("xoxb-test-token");
    const result = await adapter.read({ channel: "C01234", limit: 10 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.messages).toHaveLength(2);
      expect(result.value.messages[0].text).toBe("hello");
      expect(result.value.messages[0].senderId).toBe("U01");
      expect(result.value.messages[0]._flnx_untrusted).toBe(true);
      expect(result.value.messages[0]._flnx_source).toBe("slack");
      expect(result.value.hasMore).toBe(false);
    }
  });

  test("reads thread replies when threadId provided", async () => {
    installMock((url) => {
      expect(url).toBe("https://slack.com/api/conversations.replies");
      return slackOk({
        messages: [{ ts: "1.1", text: "reply", user: "U01" }],
        has_more: false,
      });
    });

    const adapter = new SlackAdapter("xoxb-test-token");
    const result = await adapter.read({
      channel: "C01",
      limit: 5,
      threadId: "1712023032.100000",
    });
    expect(result.ok).toBe(true);
  });

  test("normalizes messages with all fields", async () => {
    installMock(() =>
      slackOk({
        messages: [
          {
            ts: "1712023032.100000",
            text: "with file",
            user: "U01",
            username: "alice",
            thread_ts: "1712023032.000000",
            files: [
              {
                id: "F01",
                name: "report.pdf",
                mimetype: "application/pdf",
                url_private: "https://files.slack.com/F01",
                size: 1024,
              },
            ],
          },
        ],
        has_more: true,
        response_metadata: { next_cursor: "cursor123" },
      })
    );

    const adapter = new SlackAdapter("xoxb-test-token");
    const result = await adapter.read({ channel: "C01", limit: 1 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const msg = result.value.messages[0];
      expect(msg.platform).toBe("slack");
      expect(msg.senderName).toBe("alice");
      expect(msg.threadId).toBe("1712023032.000000");
      expect(msg.attachments).toHaveLength(1);
      expect(msg.attachments![0].filename).toBe("report.pdf");
      expect(msg.attachments![0].sizeBytes).toBe(1024);
      expect(result.value.hasMore).toBe(true);
      expect(result.value.cursor).toBe("cursor123");
    }
  });

  test("handles empty message list", async () => {
    installMock(() => slackOk({ messages: [], has_more: false }));

    const adapter = new SlackAdapter("xoxb-test-token");
    const result = await adapter.read({ channel: "C01", limit: 10 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.messages).toHaveLength(0);
    }
  });
});

// ─── react ────────────────────────────────────────────────────────────────

describe("SlackAdapter.react", () => {
  test("adds a reaction", async () => {
    installMock((url, init) => {
      expect(url).toBe("https://slack.com/api/reactions.add");
      const body = JSON.parse(init.body as string);
      expect(body.name).toBe("thumbsup");
      expect(body.timestamp).toBe("1712023032.123456");
      return slackOk({});
    });

    const adapter = new SlackAdapter("xoxb-test-token");
    const result = await adapter.react({
      channel: "C01",
      timestamp: "1712023032.123456",
      emoji: "thumbsup",
    });
    expect(result.ok).toBe(true);
  });

  test("treats already_reacted as success", async () => {
    installMock(() => slackErr("already_reacted"));

    const adapter = new SlackAdapter("xoxb-test-token");
    const result = await adapter.react({
      channel: "C01",
      timestamp: "1712023032.123456",
      emoji: "thumbsup",
    });
    expect(result.ok).toBe(true);
  });

  test("returns error for other failures", async () => {
    installMock(() => slackErr("message_not_found"));

    const adapter = new SlackAdapter("xoxb-test-token");
    const result = await adapter.react({
      channel: "C01",
      timestamp: "1712023032.123456",
      emoji: "thumbsup",
    });
    expect(result.ok).toBe(false);
  });
});

// ─── upload ───────────────────────────────────────────────────────────────

describe("SlackAdapter.upload", () => {
  test("completes three-step upload flow", async () => {
    let step = 0;
    installMock((url, init) => {
      step++;
      if (step === 1) {
        // Step 1: Get upload URL
        expect(url).toBe("https://slack.com/api/files.getUploadURLExternal");
        return slackOk({
          upload_url: "https://files.slack.com/upload/xyz",
          file_id: "F01ABC",
        });
      }
      if (step === 2) {
        // Step 2: Upload file content
        expect(url).toBe("https://files.slack.com/upload/xyz");
        expect(init.method).toBe("POST");
        return new Response("OK", { status: 200 });
      }
      // Step 3: Complete upload
      expect(url).toBe("https://slack.com/api/files.completeUploadExternal");
      return slackOk({});
    });

    const adapter = new SlackAdapter("xoxb-test-token");
    const result = await adapter.upload({
      channel: "C01",
      filePath: "/home/blakfinlabs/Desktop/flnx-messaging/src/types/index.ts",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fileId).toBe("F01ABC");
      expect(result.value.filename).toBe("index.ts");
    }
    expect(step).toBe(3);
  });

  test("returns error if getUploadURL fails", async () => {
    installMock(() => slackErr("not_allowed"));

    const adapter = new SlackAdapter("xoxb-test-token");
    const result = await adapter.upload({
      channel: "C01",
      filePath: "/home/blakfinlabs/Desktop/flnx-messaging/src/types/index.ts",
    });
    expect(result.ok).toBe(false);
  });
});

// ─── listChannels ─────────────────────────────────────────────────────────

describe("SlackAdapter.listChannels", () => {
  test("returns normalized channel list", async () => {
    installMock((url) => {
      expect(url).toBe("https://slack.com/api/conversations.list");
      return slackOk({
        channels: [
          { id: "C01", name: "general", is_private: false, num_members: 42 },
          { id: "C02", name: "secret", is_private: true, num_members: 3 },
        ],
      });
    });

    const adapter = new SlackAdapter("xoxb-test-token");
    const result = await adapter.listChannels();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      expect(result.value[0]).toEqual({
        id: "C01",
        name: "general",
        platform: "slack",
        isPrivate: false,
        memberCount: 42,
      });
      expect(result.value[1].isPrivate).toBe(true);
    }
  });

  test("handles empty channel list", async () => {
    installMock(() => slackOk({ channels: [] }));

    const adapter = new SlackAdapter("xoxb-test-token");
    const result = await adapter.listChannels();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(0);
    }
  });
});

// ─── healthCheck ──────────────────────────────────────────────────────────

describe("SlackAdapter.healthCheck", () => {
  test("returns health status", async () => {
    installMock((url) => {
      expect(url).toBe("https://slack.com/api/auth.test");
      return slackOk({
        user_id: "U01ABC",
        user: "flnx-bot",
        team: "My Workspace",
      });
    });

    const adapter = new SlackAdapter("xoxb-test-token");
    const result = await adapter.healthCheck();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.platform).toBe("slack");
      expect(result.value.ok).toBe(true);
      expect(result.value.userId).toBe("U01ABC");
      expect(result.value.userName).toBe("flnx-bot");
      expect(result.value.teamName).toBe("My Workspace");
      expect(result.value.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  test("returns AUTH_FAILED on invalid token", async () => {
    installMock(() => slackErr("invalid_auth"));

    const adapter = new SlackAdapter("xoxb-bad-token");
    const result = await adapter.healthCheck();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("AUTH_FAILED");
    }
  });
});
