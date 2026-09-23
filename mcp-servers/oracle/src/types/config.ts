export interface ServerConfig {
  ORACLE_MCP_PORT: number;
}

export interface DatabaseConfig {
  ORACLE_CONNECT_STRING: string;
  ORACLE_USER: string;
  ORACLE_PASSWORD: string;
  ORACLE_DEFAULT_SCHEMA?: string;
}
