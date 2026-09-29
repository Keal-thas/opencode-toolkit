export interface ServerConfig {
  JAVA_LSP_MCP_PORT: number;
}

export interface JavaLspConfig {
  JAVA_LSP_WORKSPACE_ROOT: string;
  JDTLS_DATA_DIR: string;
  JDTLS_COMMAND?: string;
  // The java that launches jdtls itself - jdtls requires 21+, see README.md's "JDK version" section.
  KEALTHAS_JAVA_LSP_JDTLS_LAUNCHER_JAVA_EXECUTABLE?: string;
  // The JDKs the analyzed project builds against, handed to jdtls as java.configuration.runtimes.
  KEALTHAS_JAVA_LSP_ANALYZED_PROJECT_JDK_RUNTIMES?: { name: string; path: string; default?: boolean }[];
}
