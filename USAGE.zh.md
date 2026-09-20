# 使用手册(中文)

面向日常操作的中文速查手册:怎么在本地开发/测试,各目录是做什么的,遇到问题去哪找更详细的文档.项目整体介绍见 [README.md](README.md);部署到目标机器的步骤见 [SETUP.md](SETUP.md)(英文,给 agent 直接执行),配套的中文讲解见 [SETUP-notes.zh.md](SETUP-notes.zh.md).

## 本地开发与测试

所有开发和测试都在 `docker/` 沙箱里进行,不要直接用宿主机自己的 node/opencode/npm 环境.

- 跑全套测试:`./tests/run-all.sh`(会先构建沙箱镜像,再跑完整测试套件)
- 更快的单次迭代:`docker/dev.sh run --rm opencode-dev bash tests/run-in-container.sh`
- 始终用 `docker/dev.sh`,不要直接用 `docker compose`——它会按当前 worktree 隔离 Compose 项目名,避免多个 worktree 并发时互相冲突,细节见 `docker/docker-notes.md`
- 例外:`tests/integration/docker-prompt-override.test.sh` 在宿主机上跑,因为它本身就是负责发起 `docker run` 的那一层;它实际断言的内容仍然全部发生在一次性容器内部

## 目录速查

| 目录 | 用途 |
|---|---|
| `deploy/` | 部署到目标机器的内容:prompt 覆盖文件、完整 opencode.json 配置、离线 models 目录快照 |
| `docker/` | 本地开发/测试沙箱 |
| `plugins/` | opencode 插件(system-prompt-tools / hook-logger / llm-review-gate),各自独立发布到 npm |
| `toolkits/` | 以客户端方式驱动 opencode 的独立脚本,目前只有 `module-analysis/`(给大代码库生成架构分析文档) |
| `mcp-servers/` | MCP 服务器:Oracle/Loki 运维工具、官方 memory server 接入,以及 Java/Spring 的 LSP 桥接 |
| `docs/` | 研究笔记、opencode 官方文档本地镜像、功能点清单 |
| `tests/` | 自动化测试,入口是 `./tests/run-all.sh` |
| `memory/` | Git 跟踪的项目记忆(跨环境共享,不放在某台机器本地的 AI 工具记忆里) |
| `scripts/` | 发布/维护用的一次性脚本,如 `publish-npm.sh` |

更完整的表格(含每个子目录里具体有什么)见 README.md 的 "Repo layout" 部分.

## 部署到目标机器

目标机器是离线的 Windows + git-bash 环境,没有公网,只有能下载(不能发布)的内网 npm 镜像.完整可执行步骤见 SETUP.md;旁观部署过程、想知道每一步具体在做什么/怎么判断做对了,看 SETUP-notes.zh.md.

## 发布

`scripts/publish-npm.sh` 把仓库当前 `HEAD` 打包发布为 `@kealthas-dev/opencode-toolkit`(npm 上的下载渠道之一,不是真实依赖);`plugins/` 下的每个插件各自独立发布,push 到 master 且改动了某个 `plugins/*/package.json` 时由 CI 自动触发.细节见 CLAUDE.md 里 "Whole-repo npm publish" 一节.

## 更多背景

日常协作约定(提交规范、分支策略、常踩的坑)见 CLAUDE.md;具体的历史调试/验证经验见 docs/lessons-learned.md;还没做但该做的事见 TODO.md.
