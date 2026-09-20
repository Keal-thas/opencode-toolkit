# 部署说明(中文,对照 SETUP.md)

SETUP.md 由 opencode 自己在受限机器上执行(没有公网,先把仓库打包传过去,再照着文件一步步跑).这份文件给旁边看着的人用,按相同的步骤编号说明每步在做什么,怎么判断做对了.命令本身以 SETUP.md 为准.

## 背景

机器没有公网,但内网有一个能下载(不能发布自己代码)的 npm registry.仓库以 zip 形式传过来解压(沙箱环境拖拽导出,不是真 U 盘).目标:用 `deploy/system-prompt.txt` 替换掉 opencode 内置的默认 prompt,不破坏机器上已经配好的 vLLM provider 配置.

## 0. 确认目录 + 找到源码

`opencode debug paths` 打印各目录,`config` 行是要改的目标目录(记作 $CONFIG_DIR),`cache` 行(记作 $CACHE_DIR)第 4/5 步要用.再确认解压出来的 `opencode-toolkit-master` 文件夹确实存在.

## 1. 拷贝 prompt 文件

把 `deploy/system-prompt.txt` 复制到 $CONFIG_DIR.纯拷贝,不涉及判断.

## 2. 接入 opencode.json

没有 opencode.json 就用 `deploy/opencode.json.example` 起步,再手动补上真实的 vLLM provider 配置(仓库不知道真实地址).已经有的话,只合并 `agent` 字段(build/plan/general 都指向 system-prompt.txt),不要动已有的 provider,权限等配置.改完用 `python -m json.tool` 之类工具验证 JSON 语法没错.

## 3. (可选)models.dev 目录数据走本地文件

这台机器没网,opencode 每小时一次的目录刷新注定失败,但无害——离线版本编译时已经打包了旧数据,启动不受影响,失败只往日志写一行错误.这套配置的 provider 是手写在 opencode.json 里的,本来就不查这个目录.

想要比编译时快照新一点的数据:把仓库里的 `deploy/models-dev-snapshot.json`(来自能联网的机器上跑 `opencode models --refresh`)拷进 $CONFIG_DIR,然后**同时**设两个环境变量,缺一不可——`OPENCODE_MODELS_PATH` 只影响启动时第一次读取,后台每小时的刷新任务看的是另一个缓存目录的文件修改时间,跟这个变量无关,必须搭配 `OPENCODE_DISABLE_MODELS_FETCH=1` 才能真正止住每小时的联网尝试:

```
OPENCODE_MODELS_PATH=<拷贝后那个 json 文件的绝对路径>
OPENCODE_DISABLE_MODELS_FETCH=1
```

## 4. (建议做)装查看器插件

装这个插件是为了能亲眼看到真正发给模型的 prompt——opencode.json 语法没错不代表覆盖真的在运行时生效了,这是唯一能确认的办法.这插件是发布到 npm 的正式包(`@kealthas-dev/opencode-system-prompt-tools`),不用手动解包进缓存目录——opencode 自己的 npm 插件加载器会装.如果第 2 步是直接拷贝 `opencode.json.example` 新建的,这一项(连同第 5 步那两个)默认已经在里面了,不用再加.如果是合并进已有的 opencode.json,在 plugin 数组里写裸包名(不带版本号)就行:

```json
"plugin": ["@kealthas-dev/opencode-system-prompt-tools"]
```

opencode 第一次用到这条配置时会自己跑一次真正的 `npm install`(走这台机器配置的那个 registry,也就是内网镜像),装完缓存住,以后就不用再装了.不写版本号意味着每次全新缓存都会拿当时 registry 上 `latest` 标的版本——但装完之后不会自动再更新.如果 `opencode debug config` 里没能正确解析这个 plugin,如实汇报看到的情况,不要瞎猜着改.

## 5. (默认已包含)hook-logger / llm-review-gate

跟 prompt 覆盖无关,`opencode.json.example` 默认把这两个也一起打包进去了(Franco 决定的).`llm-review-gate.ts` 会真的改变运行时行为(每次 bash 调用前多一次隐藏的 LLM 审核)——不想要的话把 `@kealthas-dev/opencode-llm-review-gate` 从 plugin 数组里删掉.如果第 2 步是合并进已有的 opencode.json,同第 4 步一样手动加上:

```json
"plugin": ["@kealthas-dev/opencode-hook-logger", "@kealthas-dev/opencode-llm-review-gate"]
```

合并进第 4 步已有的 plugin 数组,不要覆盖.`hook-logger.ts` 把 hook 事件记成 JSONL,纯调试用.`llm-review-gate.ts` 给每次 bash 调用加一道隐藏的 LLM 审核(会真的改变运行时行为,装之前确认这是想要的效果).

## 6. (可选)Oracle MCP server

`mcp-servers/oracle/` 需要 `@modelcontextprotocol/sdk` 和 `oracledb` 这两个 npm 依赖——这台机器没有公网,但内网 registry 是公共 npm 的完整镜像,正常 `npm install` 就能装上(仓库没打包这两个依赖,跟第 4/5 步那种零依赖的插件不一样).如果 `npm install` 意外失败了,汇报出来,不要瞎猜替代方案.`type: "remote"`——server 得有人自己单独 `npm start` 并保持运行,opencode 不管它的死活.真实连接信息(ORACLE_CONNECT_STRING/USER/PASSWORD)问操作的人要.

## 7. (可选)Loki MCP server

跟第 6 步同样情况:`mcp-servers/loki/` 只需要 `@modelcontextprotocol/sdk` 一个依赖(没有 oracledb 那种驱动),同样走 `npm install`.同样 `type: "remote"`,同样要人单独启动并保持运行.只有 `LOKI_BASE_URL` 是必须问的,账号密码/租户 ID 视那台 Loki 是否要求而定.

## 8. 验证

跑一句最简单的测试请求,装了第 4 步插件的话再打开 `~/.local/share/opencode/last-system-prompt.txt`——应该以 system-prompt.txt 的内容开头,后面跟着 opencode 自己生成的 `<env>` 信息块.如果看到的还是原来啰嗦的开场白,说明 opencode.json 没生效,先查 JSON 有没有写错.

## 9. (可选)清理

zip 和解压出来的文件夹用完可以删,长期要留的只有 $CONFIG_DIR 里的 system-prompt.txt(装了插件的话,$CACHE_DIR/packages/ 下那几个对应的目录;装了 MCP server 的话,那些文件也要留着).删之前问一下操作的人要不要留,不要自作主张.

## 跑完之后要说清楚的事

- opencode.json 之前有没有?是新建的还是合并进去的?
- 第 8 步验证有没有确认新 prompt 真的生效了?没生效的话实际看到的输出长什么样?
- 第 4/5 步装了哪些插件?包缓存目录是不是按预期被 opencode 识别了(`opencode debug config` 的 plugin_origins)?
- 第 6/7 步的 `npm install` 有没有真的跑通(内网 registry 是否如预期可用)?
