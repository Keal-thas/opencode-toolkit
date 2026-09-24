export interface ServerConfig {
  LOKI_MCP_PORT: number;
}

export interface LokiConfig {
  LOKI_BASE_URL: string;
  LOKI_USERNAME?: string;
  LOKI_PASSWORD?: string;
  LOKI_ORG_ID?: string;
  // Only matters for resolveTimeParam()'s "naive" datetime case - Loki itself
  // only ever sees a fully-qualified offset or an epoch.
  LOKI_DEFAULT_TZ_OFFSET?: string;
  // Set when Loki has no reachable port of its own and the only path in is
  // Grafana's datasource-proxy: LOKI_BASE_URL becomes Grafana's URL, and
  // requests route through /api/datasources/proxy/<id>/... instead of hitting
  // Loki directly. LOKI_USERNAME/LOKI_PASSWORD still work (Basic Auth against
  // a Grafana user, not Loki).
  LOKI_VIA_GRAFANA?: boolean;
  // The Loki datasource's numeric ID (or UID, on newer Grafana - see README's
  // Configuration section). Only read when LOKI_VIA_GRAFANA is true; defaults
  // to "1", what a single-datasource Grafana instance almost always has.
  LOKI_GRAFANA_DATASOURCE_ID?: string;
}
