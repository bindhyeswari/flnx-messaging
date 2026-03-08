// ─── HTTP Transport Layer ──────────────────────────────────────────────────
// TLS-only, no redirects, retry with exponential backoff, timeout, response
// size cap. All outbound HTTP goes through this single module.
// See: architecture doc §3.6, §4.6

import { type Result, type FlnxError, Ok, Err } from "../types/index.js";

// ─── Configuration ─────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
const HARD_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 3;
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024; // 50MB
const BASE_BACKOFF_MS = 500;

/** Hosts we're allowed to connect to. Prevents SSRF. */
const ALLOWED_HOSTS = new Set([
  "slack.com",
  "files.slack.com",
  "discord.com",
  "gateway.discord.gg",
  "graph.microsoft.com",
  "api.telegram.org",
]);

// ─── Types ─────────────────────────────────────────────────────────────────

export interface SecureRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  body?: string | ArrayBuffer | Uint8Array;
  timeoutMs?: number;
}

export interface SecureResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  rawBody?: string;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Make an HTTPS request with security controls.
 * - TLS-only (rejects http://)
 * - No redirect following
 * - Exponential backoff retry on 429 and 5xx
 * - Timeout enforcement
 * - Response size cap
 * - Host allowlist
 */
export async function secureRequest(
  url: string,
  options: SecureRequestOptions = {}
): Promise<Result<SecureResponse, FlnxError>> {
  // ── Validate URL ──
  const urlValidation = validateUrl(url);
  if (!urlValidation.ok) return urlValidation;

  const method = options.method || "GET";
  const timeoutMs = Math.min(options.timeoutMs || DEFAULT_TIMEOUT_MS, HARD_TIMEOUT_MS);

  let lastError: FlnxError | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0 && lastError) {
      const backoffMs = calculateBackoff(attempt, lastError);
      await sleep(backoffMs);
    }

    const result = await executeRequest(url, method, options, timeoutMs);

    if (result.ok) {
      const response = result.value;

      // Retry on 429 or 5xx
      if (response.status === 429) {
        const retryAfter = parseRetryAfter(response.headers["retry-after"]);
        lastError = { code: "RATE_LIMITED", retryAfterMs: retryAfter };
        continue;
      }
      if (response.status >= 500) {
        lastError = {
          code: "NETWORK_ERROR",
          message: `Server error ${response.status} from ${hostOf(url)}`,
          retryable: true,
        };
        continue;
      }

      return Ok(response);
    }

    // Network-level error
    lastError = result.error;

    // Only retry if the error is retryable
    if (result.error.code === "NETWORK_ERROR" && result.error.retryable) {
      continue;
    }

    // Non-retryable error — bail immediately
    return result;
  }

  // Exhausted retries
  return Err(lastError!);
}

// ─── Private: Execute Single Request ───────────────────────────────────────

async function executeRequest(
  url: string,
  method: string,
  options: SecureRequestOptions,
  timeoutMs: number
): Promise<Result<SecureResponse, FlnxError>> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      method,
      headers: options.headers,
      body: options.body as any,
      signal: controller.signal,
      redirect: "error", // No redirect following — prevents SSRF
    });

    clearTimeout(timer);

    // Check response size via Content-Length header
    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
      return Err({
        code: "NETWORK_ERROR",
        message: `Response too large: ${contentLength} bytes exceeds ${MAX_RESPONSE_BYTES} byte limit`,
        retryable: false,
      });
    }

    // Read response body with size enforcement
    const rawBody = await readResponseBody(response);
    if (!rawBody.ok) return rawBody;

    // Parse JSON if content-type indicates it
    const contentType = response.headers.get("content-type") || "";
    let body: unknown;
    if (contentType.includes("application/json")) {
      try {
        body = JSON.parse(rawBody.value);
      } catch {
        body = rawBody.value;
      }
    } else {
      body = rawBody.value;
    }

    // Extract headers into plain object
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    return Ok({ status: response.status, headers, body, rawBody: rawBody.value });
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return Err({
        code: "NETWORK_ERROR",
        message: `Request to ${hostOf(url)} timed out after ${timeoutMs}ms`,
        retryable: true,
      });
    }

    // Redirect rejection (fetch with redirect: "error" throws TypeError)
    if (err instanceof TypeError && String(err.message).includes("redirect")) {
      return Err({
        code: "NETWORK_ERROR",
        message: `Request to ${hostOf(url)} was redirected — blocked for security`,
        retryable: false,
      });
    }

    const message = err instanceof Error ? err.message : String(err);
    return Err({
      code: "NETWORK_ERROR",
      message: `Request to ${hostOf(url)} failed: ${message}`,
      retryable: true,
    });
  }
}

// ─── Private: Read Response Body ───────────────────────────────────────────

async function readResponseBody(
  response: Response
): Promise<Result<string, FlnxError>> {
  try {
    const reader = response.body?.getReader();
    if (!reader) {
      return Ok(await response.text());
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        reader.cancel();
        return Err({
          code: "NETWORK_ERROR",
          message: `Response body exceeded ${MAX_RESPONSE_BYTES} byte limit`,
          retryable: false,
        });
      }

      chunks.push(value);
    }

    const decoder = new TextDecoder();
    return Ok(chunks.map((c) => decoder.decode(c, { stream: true })).join("") + decoder.decode());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Err({
      code: "NETWORK_ERROR",
      message: `Failed to read response body: ${message}`,
      retryable: false,
    });
  }
}

// ─── Private: URL Validation ───────────────────────────────────────────────

function validateUrl(url: string): Result<void, FlnxError> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Err({
      code: "NETWORK_ERROR",
      message: `Invalid URL: ${url}`,
      retryable: false,
    });
  }

  // TLS-only
  if (parsed.protocol !== "https:") {
    return Err({
      code: "NETWORK_ERROR",
      message: `Only HTTPS is allowed. Rejected: ${parsed.protocol}//${parsed.hostname}`,
      retryable: false,
    });
  }

  // Host allowlist
  const host = parsed.hostname;
  const isAllowed = ALLOWED_HOSTS.has(host) ||
    [...ALLOWED_HOSTS].some((allowed) => host.endsWith(`.${allowed}`));

  if (!isAllowed) {
    return Err({
      code: "NETWORK_ERROR",
      message: `Host not in allowlist: ${host}. Allowed: ${[...ALLOWED_HOSTS].join(", ")}`,
      retryable: false,
    });
  }

  return Ok(undefined);
}

// ─── Private: Helpers ──────────────────────────────────────────────────────

function calculateBackoff(attempt: number, lastError: FlnxError): number {
  // Respect Retry-After for rate limits
  if (lastError.code === "RATE_LIMITED") {
    return Math.min(lastError.retryAfterMs, HARD_TIMEOUT_MS);
  }

  // Exponential backoff with jitter
  const baseMs = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
  const jitter = Math.random() * baseMs * 0.5;
  return Math.min(baseMs + jitter, 30_000);
}

function parseRetryAfter(header: string | undefined): number {
  if (!header) return 5_000;
  const seconds = parseFloat(header);
  if (isNaN(seconds)) return 5_000;
  return Math.min(seconds * 1000, 60_000);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
