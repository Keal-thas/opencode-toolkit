export interface ServerConfig {
  MYSQL_MCP_PORT: number;
}

export interface DatabaseConfig {
  // mysql://user:password@host:port/database - passed straight to
  // mysql2's createConnection(uri), which parses it natively. Any
  // reserved character in the password (@ : / ? # space, ...) must be
  // percent-encoded first, since those are also the URI's own delimiters
  // - see README.md's Configuration section.
  MYSQL_CONNECT_STRING: string;
}
