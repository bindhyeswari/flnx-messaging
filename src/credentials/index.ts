// ─── Credential Manager ────────────────────────────────────────────────────
// Token resolution, storage, and security checks.
// See: architecture doc §4.1
// OWASP MCP01:2025 (Token Mismanagement), A07:2025 (Auth Failures)

import {
  type Result,
  type FlnxError,
  type PlatformType,
  Ok,
  Err,
} from "../types/index.js";

import { join } from "node:path";
import { homedir } from "node:os";
import { stat, chmod, mkdir } from "node:fs/promises";

// ─── Constants ─────────────────────────────────────────────────────────────

const CONFIG_DIR = join(homedir(), ".config", "flnx");
const CREDENTIALS_FILE = join(CONFIG_DIR, "credentials.json");
const REQUIRED_MODE = 0o600; // Owner read/write only

const ENV_VAR_MAP: Record<PlatformType, string> = {
  slack: "FLNX_SLACK_TOKEN",
  discord: "FLNX_DISCORD_TOKEN",
  teams: "FLNX_TEAMS_TOKEN",
  telegram: "FLNX_TELEGRAM_TOKEN",
};

// ─── Credential File Schema ────────────────────────────────────────────────

interface CredentialFile {
  version: 1;
  credentials: Partial<Record<PlatformType, {
    default: {
      token: string;
      scopes?: string[];
      created_at: string;
      expires_at?: string | null;
    };
  }>>;
}

// ─── Public API ────────────────────────────────────────────────────────────

export interface ResolvedToken {
  token: string;
  source: "flag" | "env" | "file";
}

/**
 * Resolve a token for the given platform.
 * Resolution order: --token flag → env var → credential file
 */
export async function resolveToken(
  platform: PlatformType,
  flagToken?: string
): Promise<Result<ResolvedToken, FlnxError>> {
  // 1. --token flag
  if (flagToken) {
    if (process.stderr.isTTY) {
      console.error(
        "Warning: --token flag exposes credentials in process lists. Prefer FLNX_*_TOKEN env vars."
      );
    }
    return Ok({ token: flagToken, source: "flag" });
  }

  // 2. Environment variable
  const envVar = ENV_VAR_MAP[platform];
  const envToken = process.env[envVar];
  if (envToken) {
    return Ok({ token: envToken, source: "env" });
  }

  // 3. Credential file
  const fileResult = await readCredentialFile();
  if (fileResult.ok) {
    const creds = fileResult.value;
    const platformCreds = creds.credentials[platform];
    if (platformCreds?.default?.token) {
      return Ok({ token: platformCreds.default.token, source: "file" });
    }
  }

  return Err({
    code: "AUTH_FAILED",
    message: `No ${platform} token found.`,
    hint: `Set ${envVar}, use --token, or run: flnx credential --set --platform ${platform} --token <token>`,
  });
}

/**
 * Save a token to the credential file (~/.config/flnx/credentials.json).
 * Creates the file with mode 0600 if it doesn't exist.
 */
export async function saveToken(
  platform: PlatformType,
  token: string
): Promise<Result<void, FlnxError>> {
  try {
    // Ensure config directory exists
    await mkdir(CONFIG_DIR, { recursive: true });

    // Read existing file or create new
    let creds: CredentialFile;
    const existing = await readCredentialFile();
    if (existing.ok) {
      creds = existing.value;
    } else {
      creds = { version: 1, credentials: {} };
    }

    // Update token
    creds.credentials[platform] = {
      default: {
        token,
        created_at: new Date().toISOString(),
        expires_at: null,
      },
    };

    // Write with restricted permissions
    await Bun.write(CREDENTIALS_FILE, JSON.stringify(creds, null, 2));
    await chmod(CREDENTIALS_FILE, REQUIRED_MODE);

    const hint = tokenHint(token);
    console.log(`Saved ${platform} credential (token: ...${hint})`);

    return Ok(undefined);
  } catch (err) {
    return Err({
      code: "CONFIG_ERROR",
      message: `Failed to save credentials: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

/**
 * Return the last 4 characters of a token for logging/debugging.
 * Never log the full token. OWASP MCP01:2025.
 */
export function tokenHint(token: string): string {
  if (token.length <= 4) return "****";
  return token.slice(-4);
}

// ─── Private ───────────────────────────────────────────────────────────────

async function readCredentialFile(): Promise<Result<CredentialFile, FlnxError>> {
  try {
    const file = Bun.file(CREDENTIALS_FILE);
    const exists = await file.exists();
    if (!exists) {
      return Err({
        code: "CONFIG_ERROR",
        message: "Credential file not found",
      });
    }

    // Check file permissions — reject if group/other readable
    const fileStat = await stat(CREDENTIALS_FILE);
    const mode = fileStat.mode & 0o777;
    if (mode !== REQUIRED_MODE) {
      // Attempt to fix permissions
      try {
        await chmod(CREDENTIALS_FILE, REQUIRED_MODE);
      } catch {
        return Err({
          code: "CONFIG_ERROR",
          message: `Credential file has insecure permissions (${mode.toString(8)}). Expected 600. Fix with: chmod 600 ${CREDENTIALS_FILE}`,
        });
      }
    }

    const content = await file.json();
    return Ok(content as CredentialFile);
  } catch (err) {
    return Err({
      code: "CONFIG_ERROR",
      message: `Failed to read credential file: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}
