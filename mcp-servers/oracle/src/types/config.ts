export interface ServerConfig {
  ORACLE_MCP_PORT: number;
}

export interface DatabaseConfig {
  ORACLE_CONNECT_STRING: string;
  ORACLE_USER: string;
  ORACLE_PASSWORD: string;
  ORACLE_DEFAULT_SCHEMA?: string;
  // Hard cap on the rows one query may return, whatever the caller asks for.
  ORACLE_MAX_ROWS?: number;
}

export type QueryFailureKind = "blocked" | "config" | "connection" | "timeout" | "sql";

export type QueryResult =
  | { success: true; columns: string[]; rows: unknown[][]; truncated: boolean }
  | { success: false; kind: QueryFailureKind; error: string };
