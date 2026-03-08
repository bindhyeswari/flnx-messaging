import { describe, expect, test } from "bun:test";
import {
  validatePlatform,
  validateChannel,
  validateMessageText,
  validateEmoji,
  validateTimestamp,
  validateLimit,
  validateFilePath,
  sanitizeForLog,
} from "./index.js";

// ─── validatePlatform ─────────────────────────────────────────────────────

describe("validatePlatform", () => {
  test("accepts valid platforms", () => {
    for (const p of ["slack", "discord", "teams", "telegram"]) {
      const result = validatePlatform(p);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(p);
    }
  });

  test("normalizes case and whitespace", () => {
    const result = validatePlatform("  Slack  ");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("slack");
  });

  test("rejects unknown platforms", () => {
    const result = validatePlatform("irc");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.field).toBe("platform");
    }
  });
});

// ─── validateChannel ──────────────────────────────────────────────────────

describe("validateChannel", () => {
  test("accepts #channel names", () => {
    const result = validateChannel("#general");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("#general");
  });

  test("accepts @user mentions", () => {
    const result = validateChannel("@alice");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("@alice");
  });

  test("accepts plain channel names", () => {
    const result = validateChannel("ops-alerts");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("ops-alerts");
  });

  test("accepts Slack channel IDs", () => {
    const result = validateChannel("C01234ABCDE");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("C01234ABCDE");
  });

  test("accepts DM channel IDs (D prefix)", () => {
    const result = validateChannel("D01234ABCDE");
    expect(result.ok).toBe(true);
  });

  test("accepts group channel IDs (G prefix)", () => {
    const result = validateChannel("G01234ABCDE");
    expect(result.ok).toBe(true);
  });

  test("trims whitespace", () => {
    const result = validateChannel("  #general  ");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("#general");
  });

  test("rejects empty string", () => {
    const result = validateChannel("");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.field).toBe("channel");
  });

  test("rejects whitespace-only", () => {
    const result = validateChannel("   ");
    expect(result.ok).toBe(false);
  });

  test("rejects invalid characters", () => {
    const result = validateChannel("#hello world!");
    expect(result.ok).toBe(false);
  });

  test("rejects names starting with non-alphanumeric after prefix", () => {
    const result = validateChannel("#-invalid");
    expect(result.ok).toBe(false);
  });
});

// ─── validateMessageText ──────────────────────────────────────────────────

describe("validateMessageText", () => {
  test("accepts normal text", () => {
    const result = validateMessageText("Hello, world!");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("Hello, world!");
  });

  test("accepts text with newlines and tabs", () => {
    const result = validateMessageText("line1\nline2\ttab");
    expect(result.ok).toBe(true);
  });

  test("rejects empty text", () => {
    const result = validateMessageText("");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.field).toBe("text");
  });

  test("rejects text exceeding 40000 chars", () => {
    const long = "a".repeat(40_001);
    const result = validateMessageText(long);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("40000");
  });

  test("accepts text at exactly 40000 chars", () => {
    const exact = "a".repeat(40_000);
    const result = validateMessageText(exact);
    expect(result.ok).toBe(true);
  });

  test("rejects null bytes", () => {
    const result = validateMessageText("hello\x00world");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("null bytes");
  });

  test("rejects control characters", () => {
    const result = validateMessageText("hello\x01world");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("control characters");
  });

  test("allows carriage return via no match on \\r (0x0d)", () => {
    // \r (0x0d) is NOT in the control char regex range \x0e-\x1f, but IS in \x00-\x08? No.
    // The regex is: [\x00-\x08\x0b\x0c\x0e-\x1f]
    // \r = 0x0d which is NOT in that set, so it should pass (after null byte check)
    const result = validateMessageText("hello\rworld");
    expect(result.ok).toBe(true);
  });
});

// ─── validateEmoji ────────────────────────────────────────────────────────

describe("validateEmoji", () => {
  test("accepts simple emoji names", () => {
    const result = validateEmoji("thumbsup");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("thumbsup");
  });

  test("accepts emoji with underscores", () => {
    const result = validateEmoji("white_check_mark");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("white_check_mark");
  });

  test("accepts emoji with hyphens and plus", () => {
    const result = validateEmoji("+1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("+1");
  });

  test("strips surrounding colons", () => {
    const result = validateEmoji(":thumbsup:");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("thumbsup");
  });

  test("strips leading colon only", () => {
    const result = validateEmoji(":thumbsup");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("thumbsup");
  });

  test("rejects empty after trimming", () => {
    const result = validateEmoji("  ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.field).toBe("emoji");
  });

  test("rejects uppercase emoji names", () => {
    const result = validateEmoji("ThumbsUp");
    expect(result.ok).toBe(false);
  });

  test("rejects emoji with spaces", () => {
    const result = validateEmoji("thumbs up");
    expect(result.ok).toBe(false);
  });

  test("rejects colon-only input", () => {
    const result = validateEmoji("::");
    expect(result.ok).toBe(false);
  });
});

// ─── validateTimestamp ────────────────────────────────────────────────────

describe("validateTimestamp", () => {
  test("accepts valid Slack timestamp", () => {
    const result = validateTimestamp("1712023032.123456");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("1712023032.123456");
  });

  test("accepts timestamp with 1 decimal digit", () => {
    const result = validateTimestamp("1712023032.1");
    expect(result.ok).toBe(true);
  });

  test("trims whitespace", () => {
    const result = validateTimestamp("  1712023032.123456  ");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("1712023032.123456");
  });

  test("rejects missing dot", () => {
    const result = validateTimestamp("1712023032");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.field).toBe("timestamp");
  });

  test("rejects too few digits before dot", () => {
    const result = validateTimestamp("123.456");
    expect(result.ok).toBe(false);
  });

  test("rejects no digits after dot", () => {
    const result = validateTimestamp("1712023032.");
    expect(result.ok).toBe(false);
  });

  test("rejects more than 6 digits after dot", () => {
    const result = validateTimestamp("1712023032.1234567");
    expect(result.ok).toBe(false);
  });

  test("rejects non-numeric input", () => {
    const result = validateTimestamp("abc.def");
    expect(result.ok).toBe(false);
  });
});

// ─── validateLimit ────────────────────────────────────────────────────────

describe("validateLimit", () => {
  test("accepts valid integer string", () => {
    const result = validateLimit("10");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(10);
  });

  test("accepts valid number", () => {
    const result = validateLimit(50);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(50);
  });

  test("accepts boundary value 1", () => {
    const result = validateLimit(1);
    expect(result.ok).toBe(true);
  });

  test("accepts boundary value 1000", () => {
    const result = validateLimit(1000);
    expect(result.ok).toBe(true);
  });

  test("rejects 0", () => {
    const result = validateLimit(0);
    expect(result.ok).toBe(false);
  });

  test("rejects negative numbers", () => {
    const result = validateLimit(-5);
    expect(result.ok).toBe(false);
  });

  test("rejects values above 1000", () => {
    const result = validateLimit(1001);
    expect(result.ok).toBe(false);
  });

  test("rejects non-numeric strings", () => {
    const result = validateLimit("abc");
    expect(result.ok).toBe(false);
  });

  test("rejects floating point", () => {
    const result = validateLimit(3.5);
    expect(result.ok).toBe(false);
  });
});

// ─── validateFilePath ─────────────────────────────────────────────────────

describe("validateFilePath", () => {
  test("rejects non-existent file", async () => {
    const result = await validateFilePath("/tmp/flnx-test-nonexistent-file-xyz");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FILE_ERROR");
  });

  test("accepts existing file", async () => {
    // Use a file we know exists
    const result = await validateFilePath(
      "/home/blakfinlabs/Desktop/flnx-messaging/src/validation/index.ts"
    );
    expect(result.ok).toBe(true);
  });
});

// ─── sanitizeForLog ───────────────────────────────────────────────────────

describe("sanitizeForLog", () => {
  test("passes through clean strings", () => {
    expect(sanitizeForLog("hello world")).toBe("hello world");
  });

  test("strips control characters", () => {
    expect(sanitizeForLog("hello\x01world")).toBe("helloworld");
  });

  test("escapes newlines", () => {
    expect(sanitizeForLog("line1\nline2")).toBe("line1\\nline2");
  });

  test("truncates to 200 chars", () => {
    const long = "a".repeat(300);
    expect(sanitizeForLog(long)).toHaveLength(200);
  });

  test("preserves tabs", () => {
    // \t is 0x09, which is NOT in [\x00-\x08], so it should be preserved
    expect(sanitizeForLog("hello\tworld")).toBe("hello\tworld");
  });

  test("handles combined sanitization", () => {
    const input = "hello\x01\nworld\x02!";
    const result = sanitizeForLog(input);
    expect(result).toBe("hello\\nworld!");
  });
});
