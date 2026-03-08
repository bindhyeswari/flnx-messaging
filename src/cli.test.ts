import { describe, expect, test } from "bun:test";
import { $ } from "bun";

// ─── E2E CLI Tests ───────────────────────────────────────────────────────
// Run the actual CLI as a subprocess and assert on output/exit codes.

const CLI = "src/cli.ts";

/** Run CLI and return combined stdout+stderr and exit code */
async function runCli(
  args: string[],
  env?: Record<string, string>
): Promise<{ output: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args, "--no-audit"], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { output: stdout + stderr, exitCode };
}

// ─── Version & Help ──────────────────────────────────────────────────────

describe("CLI — version and help", () => {
  test("--version prints version", async () => {
    const { output, exitCode } = await runCli(["--version"]);
    expect(output).toContain("flnx-messaging v0.1.0");
    expect(exitCode).toBe(0);
  });

  test("-v prints version", async () => {
    const { output, exitCode } = await runCli(["-v"]);
    expect(output).toContain("flnx-messaging v0.1.0");
    expect(exitCode).toBe(0);
  });

  test("--help prints usage", async () => {
    const { output, exitCode } = await runCli(["--help"]);
    expect(output).toContain("USAGE:");
    expect(output).toContain("COMMANDS:");
    expect(output).toContain("send");
    expect(output).toContain("read");
    expect(output).toContain("channels");
    expect(exitCode).toBe(0);
  });

  test("no command shows help", async () => {
    const { output, exitCode } = await runCli([]);
    expect(output).toContain("USAGE:");
    expect(exitCode).toBe(0);
  });
});

// ─── Unknown Command ────────────────────────────────────────────────────

describe("CLI — unknown command", () => {
  test("unknown command exits with code 1", async () => {
    const { output, exitCode } = await runCli(["foobar"], {
      FLNX_SLACK_TOKEN: "xoxb-test",
    });
    expect(exitCode).toBe(1);
    expect(output).toContain("Unknown command");
  });
});

// ─── Missing Required Flags ─────────────────────────────────────────────

describe("CLI — missing required flags", () => {
  const withToken = { FLNX_SLACK_TOKEN: "xoxb-fake-token-for-cli-test" };

  test("send without --channel exits 3", async () => {
    const { output, exitCode } = await runCli(
      ["send", "--text", "hello"],
      withToken
    );
    expect(exitCode).toBe(3);
    expect(output).toContain("--channel");
  });

  test("read without --channel exits 3", async () => {
    const { output, exitCode } = await runCli(["read"], withToken);
    expect(exitCode).toBe(3);
    expect(output).toContain("--channel");
  });

  test("react without required flags exits 3", async () => {
    const { output, exitCode } = await runCli(
      ["react", "--channel", "test"],
      withToken
    );
    expect(exitCode).toBe(3);
    expect(output).toContain("--ts");
  });

  test("upload without --file exits 3", async () => {
    const { output, exitCode } = await runCli(
      ["upload", "--channel", "test"],
      withToken
    );
    expect(exitCode).toBe(3);
    expect(output).toContain("--file");
  });
});

// ─── Auth Failure ─────────────────────────────────────────────────────────

describe("CLI — auth", () => {
  test("missing token exits 2", async () => {
    const { output, exitCode } = await runCli(["status"], {
      PATH: process.env.PATH!,
      HOME: "/tmp/flnx-test-no-home",
      // Explicitly unset all token env vars
      FLNX_SLACK_TOKEN: "",
    });
    expect(exitCode).toBe(2);
    expect(output).toContain("AUTH_FAILED");
  });
});

// ─── Invalid Platform ───────────────────────────────────────────────────

describe("CLI — platform validation", () => {
  test("invalid platform exits 3", async () => {
    const { output, exitCode } = await runCli([
      "status",
      "--platform",
      "irc",
    ]);
    expect(exitCode).toBe(3);
    expect(output).toContain("VALIDATION_ERROR");
  });
});

// ─── Credential Command ─────────────────────────────────────────────────

describe("CLI — credential command", () => {
  test("credential without --platform exits 3", async () => {
    const { output, exitCode } = await runCli(["credential"]);
    expect(exitCode).toBe(3);
    expect(output).toContain("--platform");
  });

  test("credential --set without --token exits 3", async () => {
    const { output, exitCode } = await runCli([
      "credential",
      "--set",
      "--platform",
      "slack",
    ]);
    expect(exitCode).toBe(3);
    expect(output).toContain("--token");
  });
});
