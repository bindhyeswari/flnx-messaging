import { describe, expect, test } from "bun:test";
import { secureRequest } from "./index.js";

// ─── URL Validation (pure, no network) ────────────────────────────────────

describe("secureRequest — URL validation", () => {
  test("rejects HTTP URLs (TLS-only)", async () => {
    const result = await secureRequest("http://slack.com/api/auth.test");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NETWORK_ERROR");
      expect(result.error.message).toContain("HTTPS");
    }
  });

  test("rejects invalid URLs", async () => {
    const result = await secureRequest("not-a-url");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NETWORK_ERROR");
      expect(result.error.message).toContain("Invalid URL");
    }
  });

  test("rejects empty URL", async () => {
    const result = await secureRequest("");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NETWORK_ERROR");
    }
  });

  test("rejects FTP protocol", async () => {
    const result = await secureRequest("ftp://slack.com/files");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NETWORK_ERROR");
    }
  });
});

// ─── Host Allowlist Rejections (pure, no network) ─────────────────────────

describe("secureRequest — host allowlist rejections", () => {
  test("rejects hosts not in allowlist", async () => {
    const result = await secureRequest("https://evil.example.com/api");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NETWORK_ERROR");
      expect(result.error.message).toContain("allowlist");
    }
  });

  test("rejects similar-looking hosts (SSRF prevention)", async () => {
    const result = await secureRequest("https://slack.com.evil.com/api");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("allowlist");
    }
  });

  test("rejects localhost", async () => {
    const result = await secureRequest("https://localhost/api");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("allowlist");
    }
  });

  test("rejects IP addresses", async () => {
    const result = await secureRequest("https://127.0.0.1/api");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("allowlist");
    }
  });

  test("rejects internal IP addresses", async () => {
    const result = await secureRequest("https://192.168.1.1/api");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("allowlist");
    }
  });

  test("rejects random .com domain", async () => {
    const result = await secureRequest("https://google.com/api");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("allowlist");
    }
  });
});

// ─── Host Allowlist Accepts (mocked fetch) ────────────────────────────────
// Mock fetch to avoid network calls. URL validation runs before fetch,
// so if fetch is reached the host was accepted.

describe("secureRequest — host allowlist accepts", () => {
  const originalFetch = globalThis.fetch;

  const mockFetch = async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const testHost = async (url: string) => {
    globalThis.fetch = mockFetch as typeof fetch;
    try {
      const result = await secureRequest(url);
      expect(result.ok).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  };

  test("accepts slack.com", () => testHost("https://slack.com/api/auth.test"));
  test("accepts subdomain of slack.com", () => testHost("https://api.slack.com/test"));
  test("accepts files.slack.com", () => testHost("https://files.slack.com/test"));
  test("accepts discord.com", () => testHost("https://discord.com/api/test"));
  test("accepts graph.microsoft.com", () => testHost("https://graph.microsoft.com/test"));
  test("accepts api.telegram.org", () => testHost("https://api.telegram.org/test"));
  test("accepts gateway.discord.gg", () => testHost("https://gateway.discord.gg/test"));
});

// ─── Retry & Timeout (mocked fetch) ──────────────────────────────────────

describe("secureRequest — retry behavior", () => {
  const originalFetch = globalThis.fetch;

  test("retries on 429 and returns last error on exhaustion", async () => {
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      return new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "0" },
      });
    }) as typeof fetch;

    try {
      const result = await secureRequest("https://slack.com/api/test");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("RATE_LIMITED");
      }
      // Should have retried: 1 initial + 3 retries = 4
      expect(callCount).toBe(4);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("retries on 5xx and returns error on exhaustion", async () => {
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      return new Response("server error", {
        status: 500,
        headers: { "content-type": "text/plain" },
      });
    }) as typeof fetch;

    try {
      const result = await secureRequest("https://slack.com/api/test");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NETWORK_ERROR");
        expect(result.error.retryable).toBe(true);
      }
      expect(callCount).toBe(4);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns success on 200 without retry", async () => {
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      return new Response(JSON.stringify({ ok: true, data: "hello" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const result = await secureRequest("https://slack.com/api/test");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe(200);
        expect(result.value.body).toEqual({ ok: true, data: "hello" });
      }
      expect(callCount).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("succeeds after transient failure", async () => {
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      if (callCount < 3) {
        return new Response("error", { status: 500 });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const result = await secureRequest("https://slack.com/api/test");
      expect(result.ok).toBe(true);
      expect(callCount).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ─── Response Parsing (mocked fetch) ─────────────────────────────────────

describe("secureRequest — response parsing", () => {
  const originalFetch = globalThis.fetch;

  test("parses JSON responses", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ key: "value" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    try {
      const result = await secureRequest("https://slack.com/api/test");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.body).toEqual({ key: "value" });
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns raw text for non-JSON responses", async () => {
    globalThis.fetch = (async () =>
      new Response("plain text", {
        status: 200,
        headers: { "content-type": "text/plain" },
      })) as typeof fetch;

    try {
      const result = await secureRequest("https://slack.com/api/test");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.body).toBe("plain text");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("extracts response headers", async () => {
    globalThis.fetch = (async () =>
      new Response("ok", {
        status: 200,
        headers: {
          "content-type": "text/plain",
          "x-custom": "header-value",
        },
      })) as typeof fetch;

    try {
      const result = await secureRequest("https://slack.com/api/test");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.headers["x-custom"]).toBe("header-value");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects responses exceeding size limit via content-length", async () => {
    globalThis.fetch = (async () =>
      new Response("ok", {
        status: 200,
        headers: { "content-length": "999999999" },
      })) as typeof fetch;

    try {
      const result = await secureRequest("https://slack.com/api/test");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NETWORK_ERROR");
        expect(result.error.message).toContain("too large");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ─── Non-retryable errors return immediately ──────────────────────────────

describe("secureRequest — non-retryable errors", () => {
  test("URL validation errors are not retried", async () => {
    const start = performance.now();
    const result = await secureRequest("http://slack.com/test");
    const elapsed = performance.now() - start;

    expect(result.ok).toBe(false);
    expect(elapsed).toBeLessThan(100);
  });

  test("host allowlist errors are not retried", async () => {
    const start = performance.now();
    const result = await secureRequest("https://evil.com/test");
    const elapsed = performance.now() - start;

    expect(result.ok).toBe(false);
    expect(elapsed).toBeLessThan(100);
  });
});

// ─── Error shape ──────────────────────────────────────────────────────────

describe("secureRequest — error shapes", () => {
  test("allowlist error has correct shape", async () => {
    const result = await secureRequest("https://evil.example.com/api");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toHaveProperty("code", "NETWORK_ERROR");
      expect(result.error).toHaveProperty("message");
      expect(result.error).toHaveProperty("retryable", false);
    }
  });

  test("TLS error has correct shape", async () => {
    const result = await secureRequest("http://slack.com/api/test");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NETWORK_ERROR");
      expect(result.error.retryable).toBe(false);
    }
  });

  test("invalid URL error has correct shape", async () => {
    const result = await secureRequest("not-a-url");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NETWORK_ERROR");
      expect(result.error.retryable).toBe(false);
    }
  });
});
