export interface ServerConfig {
  JAVA_LSP_MCP_PORT: number;
}

export interface JavaLspConfig {
  JAVA_LSP_WORKSPACE_ROOT: string;
  JDTLS_DATA_DIR: string;
  JDTLS_COMMAND?: string;
  // Decoupled from whatever launches jdtls itself - see README.md's "JDK version" section.
  JAVA_EXECUTABLE?: string;
}
