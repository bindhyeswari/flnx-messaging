#!/usr/bin/env bun

import { validatePlatform } from "./validation/index.js";
import { resolveToken, saveToken } from "./credentials/index.js";
import { createAdapter } from "./adapters/adapter.js";
import {
  handleSend,
  handleRead,
  handleReact,
  handleUpload,
  handleChannels,
  handleStatus,
  type OutputFormat,
} from "./commands/index.js";
import { configureAudit, createFileSink } from "./audit/index.js";
import type { PlatformType } from "./types/index.js";

// ─── Version ───────────────────────────────────────────────────────────────

const VERSION = "0.1.0";

// ─── Arg Parsing ───────────────────────────────────────────────────────────
// Zero-dependency argument parser. Intentionally simple.

function parseArgs(argv: string[]): {
  command: string;
  flags: Record<string, string | boolean>;
  positional: string[];
} {
  const args = argv.slice(2); // skip bun and script path
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let command = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (!command && !arg.startsWith("-")) {
      command = arg;
      continue;
    }

    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        const next = args[i + 1];
        if (next && !next.startsWith("-")) {
          flags[arg.slice(2)] = next;
          i++;
        } else {
          flags[arg.slice(2)] = true;
        }
      }
    } else if (arg.startsWith("-") && arg.length === 2) {
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        flags[arg.slice(1)] = next;
        i++;
      } else {
        flags[arg.slice(1)] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { command, flags, positional };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function getFlag(flags: Record<string, string | boolean>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const val = flags[key];
    if (typeof val === "string") return val;
  }
  return undefined;
}

function hasFlag(flags: Record<string, string | boolean>, ...keys: string[]): boolean {
  return keys.some((k) => flags[k] === true || typeof flags[k] === "string");
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const { command, flags } = parseArgs(process.argv);

  // Global flags
  if (hasFlag(flags, "version", "v")) {
    console.log(`flnx-messaging v${VERSION}`);
    process.exit(0);
  }

  if (hasFlag(flags, "help", "h") || !command) {
    printUsage();
    process.exit(0);
  }

  // Output format
  const format: OutputFormat = hasFlag(flags, "json") ? "json" : "text";

  // Audit config
  const auditFile = getFlag(flags, "audit-log");
  if (auditFile) {
    configureAudit({ sink: createFileSink(auditFile) });
  }
  if (hasFlag(flags, "no-audit")) {
    configureAudit({ enabled: false });
  }

  // Credential management subcommands (don't need a platform adapter)
  if (command === "credential") {
    await handleCredentialCommand(flags);
    return;
  }

  // ── Resolve platform and token ──
  const platformStr = getFlag(flags, "platform", "p") || process.env.FLNX_PLATFORM || "slack";
  const platformResult = validatePlatform(platformStr);
  if (!platformResult.ok) {
    console.error(formatCliError(platformResult.error));
    process.exit(3);
  }
  const platform = platformResult.value;

  const tokenResult = await resolveToken(platform, getFlag(flags, "token"));
  if (!tokenResult.ok) {
    console.error(formatCliError(tokenResult.error));
    process.exit(2);
  }
  const { token } = tokenResult.value;

  const adapter = createAdapter(platform, token);

  // ── Route command ──
  let result: { exitCode: number; output: string };

  switch (command) {
    case "send": {
      const channel = getFlag(flags, "channel", "c");
      const text = getFlag(flags, "text", "t") || flags._text as string;
      const threadId = getFlag(flags, "thread");

      if (!channel) {
        console.error("Error: --channel is required for send");
        process.exit(3);
      }
      if (!text) {
        const stdinText = await readStdin();
        if (!stdinText) {
          console.error("Error: --text is required for send (or pipe via stdin)");
          process.exit(3);
        }
        result = await handleSend(adapter, { channel, text: stdinText, threadId, token }, format);
      } else {
        result = await handleSend(adapter, { channel, text, threadId, token }, format);
      }
      break;
    }

    case "read": {
      const channel = getFlag(flags, "channel", "c");
      const limit = getFlag(flags, "limit", "l") || "10";
      const threadId = getFlag(flags, "thread");

      if (!channel) {
        console.error("Error: --channel is required for read");
        process.exit(3);
      }
      result = await handleRead(adapter, { channel, limit, threadId, token }, format);
      break;
    }

    case "react": {
      const channel = getFlag(flags, "channel", "c");
      const ts = getFlag(flags, "ts", "timestamp");
      const emoji = getFlag(flags, "emoji", "e");

      if (!channel || !ts || !emoji) {
        console.error("Error: --channel, --ts, and --emoji are required for react");
        process.exit(3);
      }
      result = await handleReact(adapter, { channel, timestamp: ts, emoji, token }, format);
      break;
    }

    case "upload": {
      const channel = getFlag(flags, "channel", "c");
      const filePath = getFlag(flags, "file", "f");
      const filename = getFlag(flags, "filename");
      const title = getFlag(flags, "title");
      const threadId = getFlag(flags, "thread");

      if (!channel || !filePath) {
        console.error("Error: --channel and --file are required for upload");
        process.exit(3);
      }
      result = await handleUpload(adapter, { channel, filePath, filename, title, threadId, token }, format);
      break;
    }

    case "channels": {
      result = await handleChannels(adapter, { token }, format);
      break;
    }

    case "status": {
      result = await handleStatus(adapter, { token }, format);
      break;
    }

    default: {
      console.error(`Unknown command: "${command}". Run flnx --help for usage.`);
      process.exit(1);
    }
  }

  // ── Output ──
  if (result.output) {
    if (result.exitCode === 0) {
      console.log(result.output);
    } else {
      console.error(result.output);
    }
  }
  process.exit(result.exitCode);
}

// ─── Credential Subcommand ─────────────────────────────────────────────────

async function handleCredentialCommand(flags: Record<string, string | boolean>) {
  const platformStr = getFlag(flags, "platform", "p");

  if (!platformStr) {
    console.error("Error: --platform is required for credential commands");
    process.exit(3);
  }

  const platformResult = validatePlatform(platformStr);
  if (!platformResult.ok) {
    console.error(formatCliError(platformResult.error));
    process.exit(3);
  }

  if (hasFlag(flags, "set")) {
    const token = getFlag(flags, "token");
    if (!token) {
      console.error("Error: --token is required for credential set");
      process.exit(3);
    }
    const result = await saveToken(platformResult.value, token);
    if (!result.ok) {
      console.error(formatCliError(result.error));
      process.exit(1);
    }
  } else {
    console.error('Usage: flnx credential --set --platform slack --token xoxb-...');
    process.exit(1);
  }
}

// ─── Stdin Reader ──────────────────────────────────────────────────────────

async function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf-8").trim();
  return text.length > 0 ? text : null;
}

// ─── Usage ─────────────────────────────────────────────────────────────────

function printUsage() {
  console.log(`
flnx-messaging v${VERSION}
Secure, stateless CLI for messaging platforms.

USAGE:
  flnx <command> [options]

COMMANDS:
  send       Send a message to a channel
  read       Read messages from a channel
  react      Add an emoji reaction to a message
  upload     Upload a file to a channel
  channels   List accessible channels
  status     Check connection health and token validity
  credential Manage platform credentials

GLOBAL OPTIONS:
  --platform, -p   Platform to use (slack|discord|teams|telegram) [default: slack]
  --json           Output in NDJSON format (one JSON object per line)
  --token          API token (prefer env var: FLNX_SLACK_TOKEN)
  --audit-log      Write audit log to file instead of stderr
  --no-audit       Disable audit logging
  --help, -h       Show this help
  --version, -v    Show version

EXAMPLES:
  # Send a message
  flnx send --channel "#ops" --text "Deploy complete"

  # Pipe from stdin
  echo "Build failed" | flnx send --channel "#alerts"

  # Read last 20 messages as JSON
  flnx read --channel "#ops" --limit 20 --json

  # React to a message
  flnx react --channel "#ops" --ts 1712023032.1234 --emoji white_check_mark

  # Upload a file
  flnx upload --channel "#reports" --file ./report.pdf

  # Check connection
  flnx status

  # Set credentials (stored in ~/.config/flnx/credentials.json, mode 0600)
  flnx credential --set --platform slack --token xoxb-your-token

ENVIRONMENT:
  FLNX_SLACK_TOKEN      Slack bot token
  FLNX_DISCORD_TOKEN    Discord bot token
  FLNX_TEAMS_TOKEN      Teams bot token
  FLNX_TELEGRAM_TOKEN   Telegram bot token
  FLNX_PLATFORM         Default platform [slack]
  HTTPS_PROXY           Proxy for outbound HTTPS requests
`);
}

// ─── Error Formatting ──────────────────────────────────────────────────────

function formatCliError(error: any): string {
  let msg = `Error [${error.code}]: `;
  if (error.message) msg += error.message;
  if (error.hint) msg += `\n  Hint: ${error.hint}`;
  return msg;
}

// ─── Run ───────────────────────────────────────────────────────────────────

main().catch((e) => {
  console.error(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
