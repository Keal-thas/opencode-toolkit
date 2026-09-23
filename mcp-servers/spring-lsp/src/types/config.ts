export interface ServerConfig {
  SPRING_LSP_MCP_PORT: number;
}

export interface SpringLspConfig {
  SPRING_LSP_WORKSPACE_ROOT: string;
  // spring-boot-language-server itself needs JDK 21+ - see README's "JDK version".
  // Optional, defaults to whatever "java" resolves to on PATH.
  JAVA_EXECUTABLE?: string;
}
