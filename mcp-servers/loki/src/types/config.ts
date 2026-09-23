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
  // When Loki has no directly reachable port of its own and the only path
  // in is through Grafana's own datasource-proxy endpoint (a common setup:
  // Grafana is the one thing exposed, Loki sits behind it) - LOKI_BASE_URL
  // becomes Grafana's own base URL, and every request is routed through
  // /api/datasources/proxy/<id>/... instead of hitting Loki's API root
  // directly. LOKI_USERNAME/LOKI_PASSWORD still work unchanged in this mode
  // (Basic Auth against a real Grafana user, not Loki itself).
  LOKI_VIA_GRAFANA?: boolean;
  // The Loki datasource's numeric ID (or UID, on newer Grafana - see
  // README's Configuration section) as assigned inside that Grafana
  // instance. Only read when LOKI_VIA_GRAFANA is true; defaults to "1",
  // which is what a single-datasource Grafana instance almost always has.
  LOKI_GRAFANA_DATASOURCE_ID?: string;
}
