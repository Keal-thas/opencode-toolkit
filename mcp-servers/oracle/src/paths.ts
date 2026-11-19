import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "./types/config.js";

export const DEFAULT_PORT = 8090;
export const CONFIG_DIR = join(homedir(), ".config", "kealthas-dev", "opencode-mcp-oracle");
export const SERVER_CONFIG_PATH = join(CONFIG_DIR, "server.json");

// ORACLE_MCP_PORT env var overrides server.json, for running several
// instances (different databases/ports) without separate port files.
// Shared by the server (which listens on it) and the CLI (which connects to it).
export function loadServerConfig(): ServerConfig {
  if (process.env.ORACLE_MCP_PORT !== undefined) {
    const port = Number(process.env.ORACLE_MCP_PORT);
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`ORACLE_MCP_PORT must be a positive integer, got: ${JSON.stringify(process.env.ORACLE_MCP_PORT)}`);
    }
    return { ORACLE_MCP_PORT: port };
  }

  if (!existsSync(SERVER_CONFIG_PATH)) {
    return { ORACLE_MCP_PORT: DEFAULT_PORT };
  }

  const raw = JSON.parse(readFileSync(SERVER_CONFIG_PATH, "utf8"));
  const port = Number(raw.ORACLE_MCP_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`ORACLE_MCP_PORT in ${SERVER_CONFIG_PATH} must be a positive integer, got: ${JSON.stringify(raw.ORACLE_MCP_PORT)}`);
  }
  return { ORACLE_MCP_PORT: port };
}
