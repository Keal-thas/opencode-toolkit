# java-lsp / spring-lsp 快速跑通

本地跑,不用 docker sandbox —— 沙箱镜像没装 JDK,这两个服务的测试本来就是在宿主机跑的（见 `mcp-servers/TODO.md`）。

前提:JDK 21+(`java -version`);java-lsp 额外需要 `python3`。目标机器没有 JDK21 的话,见 SETUP.md 第 8 步(手动下载一份 JDK zip 传上去,`JAVA_EXECUTABLE` 指过去——vendor 进仓库这条路试过了,会把根包 npm 发布搞挂,已经回退,见 `docs/lessons-learned.md`)。

## java-lsp

```bash
cd mcp-servers/java-lsp
npm install
npm run build

mkdir -p ~/.config/kealthas-dev/opencode-mcp-java-lsp
cat > ~/.config/kealthas-dev/opencode-mcp-java-lsp/config.json <<'EOF'
{
  "JAVA_LSP_WORKSPACE_ROOT": "/绝对路径/到你的java项目",
  "JDTLS_DATA_DIR": "/绝对路径/到一个空目录"
}
EOF

npm start   # 看到 "listening on http://localhost:8092/mcp" 即跑通
```

冒烟测试（真实起一个 jdtls）：

```bash
npm test
```

## spring-lsp

```bash
cd mcp-servers/spring-lsp
npm install
npm run build

mkdir -p ~/.config/kealthas-dev/opencode-mcp-spring-lsp
cat > ~/.config/kealthas-dev/opencode-mcp-spring-lsp/config.json <<'EOF'
{
  "SPRING_LSP_WORKSPACE_ROOT": "/绝对路径/到你的spring-boot项目"
}
EOF

npm start   # 监听 http://localhost:8093/mcp
```

冒烟测试：

```bash
npm test
```

## 接入 opencode

```json
"mcp": {
  "java-lsp": { "type": "remote", "url": "http://localhost:8092/mcp", "enabled": true },
  "spring-lsp": { "type": "remote", "url": "http://localhost:8093/mcp", "enabled": true }
}
```

## 常见问题

- 端口被占用：写 `server.json`，`{"JAVA_LSP_MCP_PORT": <端口>}` / `{"SPRING_LSP_MCP_PORT": <端口>}`，同时改上面 `url` 里的端口。
- 改了 `config.json` 不生效：这两个服务配置只在启动时读一次（LSP 会话本身是有状态的），改完要重启进程，不像 oracle/loki 每次调用都重读。
