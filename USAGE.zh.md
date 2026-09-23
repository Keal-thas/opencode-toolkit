# 使用手册(中文)

这个仓库要做的事:把 opencode 内置的啰嗦系统 prompt 换成精简版,顺带打包了几个 opencode 插件和几个 MCP 服务器。本文档只讲怎么把这些东西接到一台 opencode 上跑起来,按操作步骤精简写,完整到可以照抄执行的英文版本见 SETUP.md;仓库整体是什么、目录结构见 README.md。

## 部署环境

目标机器:没有公网,但有能下载(不能发布)的内网 npm 镜像,Windows + git-bash,opencode 已经装好。仓库以 zip 或 `npm pack @kealthas-dev/opencode-toolkit` 两种方式之一传过去,解压后是一个普通目录。

## 关键步骤

1. `opencode debug paths` 找到 `config` 目录(记作 `$CONFIG_DIR`)。
2. 把 `deploy/system-prompt.txt` 拷贝到 `$CONFIG_DIR`。
3. `$CONFIG_DIR/opencode.json` 不存在就直接拷贝 `deploy/opencode.json.example`;已经存在就只合并它的 `agent`/`plugin`/`mcp` 三个字段,不要动已有的 provider、权限等配置。
4. `deploy/opencode.json.example` 里三个插件(system-prompt-tools 查看器、hook-logger、llm-review-gate)和五个 MCP 服务器(oracle、loki、java-lsp、spring-lsp、memory)默认全部启用,要不要真的用、要不要关掉哪个,自己决定:
   - oracle/loki/java-lsp/spring-lsp 是 `remote` 类型,要自己单独 `npm install && npm run build && npm start` 常驻。四个都是配置文件驱动的:真实连接信息写进一个 JSON 文件,路径由各自的 `<X>_CONFIG_FILE` 环境变量指定(如 `ORACLE_CONFIG_FILE`),端口则是一个固定路径下可选的 `server.json`——详见各自的 README.md。
   - memory 是 `local` 类型,opencode 自己启动,只要 `npm install -g @modelcontextprotocol/server-memory` 装一次。
5. 跑一句 `opencode run --model <provider>/<model> "say hi"`,再看 `~/.local/share/opencode/last-system-prompt.txt`——内容应该以 `system-prompt.txt` 开头,而不是原来那段啰嗦的自我介绍,这样才算真的生效。

## 各目录是什么(简版)

| 目录 | 是什么 |
|---|---|
| `deploy/` | 上面步骤用到的所有文件:system-prompt.txt、opencode.json.example、models 目录快照 |
| `plugins/` | 三个 opencode 插件,各自发布成独立的 npm 包 |
| `mcp-servers/` | 几个 MCP 服务器:Oracle/Loki 运维工具、Java/Spring 的 LSP 桥接,以及官方 memory server 的接入方式 |
| `toolkits/module-analysis/` | 独立的架构分析脚本,跟上面的部署流程无关,单独看它自己的 README |

## 更多

完整、可直接执行的英文步骤见 SETUP.md;仓库整体介绍、每个目录的详细说明见 README.md。
