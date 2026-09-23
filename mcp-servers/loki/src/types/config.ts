export interface ServerConfig {
  LOKI_MCP_PORT: number;
}

export interface LokiConfig {
  LOKI_BASE_URL: string;
  LOKI_USERNAME?: string;
  LOKI_PASSWORD?: string;
  LOKI_ORG_ID?: string;
  // Only matters for the "naive" datetime case in resolveTimeParam() - Loki
  // itself is never told about this, it only ever sees a fully-qualified
  // offset or an epoch.
  LOKI_DEFAULT_TZ_OFFSET?: string;
}
