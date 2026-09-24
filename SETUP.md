# Setup instructions (for an agent to execute)

Configure the local opencode installation on this machine to use a custom system prompt instead of the built-in default. Environment: git-bash on Windows, no public internet — an internal npm registry works for downloads (e.g. steps 6-9), but not for publishing anything. The repo arrives either as an extracted zip, or via `npm pack @kealthas-dev/opencode-toolkit` extracted to a `package/` directory (verify the package is actually published/mirrored first if using this route) — either way you end up with one plain extracted directory; step 0 just needs to find it. Don't `git clone` or fetch anything else over the network. Run each step's commands yourself, in order, and don't skip the verification step.

## 0. Find the opencode config directory and the extracted source

Run:

```bash
opencode debug paths
```

Use the `config` line from the output for all paths below (normally `~/.config/opencode` — substitute it everywhere `$CONFIG_DIR` appears if this machine differs). Also grab the `cache` line — steps 4/5 need it too. Set both as variables for the rest of this session:

```bash
CONFIG_DIR="$(opencode debug paths | awk '/^config/ {print $2}')"
CACHE_DIR="$(opencode debug paths | awk '/^cache/ {print $2}')"
echo "$CONFIG_DIR"
echo "$CACHE_DIR"
```

Now find where the extracted source landed, somewhere on this machine (Desktop, Downloads, wherever it was extracted to). Its name depends on how it got here: `opencode-toolkit-master` if it's the GitHub zip export (branch name appended, unless renamed), or `package` if it's an extracted `npm pack` tarball. Locate it, e.g.:

```bash
find ~/Desktop ~/Downloads -maxdepth 2 \( -iname "opencode-toolkit*" -o -iname "package" \) -type d 2>/dev/null
```

Set it as a variable — substitute the real path you found:

```bash
SRC_DIR="/path/to/opencode-toolkit-master"
ls "$SRC_DIR"   # sanity check: should show README.md, deploy/, etc.
```

## 1. Copy the files in

```bash
cp "$SRC_DIR/deploy/system-prompt.txt" "$CONFIG_DIR/system-prompt.txt"
```

## 2. Wire it into opencode.json

Check whether `$CONFIG_DIR/opencode.json` already exists.

- **If it does NOT exist yet**: copy the example as a starting point, then edit it to add your actual provider/model config (vLLM) on top — this repo doesn't know your exact provider setup, beyond the model server exposing an OpenAI-compatible API, which opencode supports as a provider type natively.

  ```bash
  cp "$SRC_DIR/deploy/opencode.json.example" "$CONFIG_DIR/opencode.json"
  ```

- **If it already exists** (most likely — your vLLM provider is probably already configured there): read it, then add these exact keys to the top-level JSON object, merging with whatever is already there. Do not remove or alter any existing keys (provider config, permissions, etc.) — only add/merge the `agent` and `permission` keys:

  ```json
  "permission": {
    "review_verdict": "deny"
  },
  "agent": {
    "build": {
      "prompt": "{file:./system-prompt.txt}"
    },
    "plan": {
      "prompt": "{file:./system-prompt.txt}"
    },
    "general": {
      "prompt": "{file:./system-prompt.txt}"
    },
    "review-gate": {
      "description": "Internal ALLOW/BLOCK safety reviewer used by the llm-review-gate plugin. Not user-facing.",
      "mode": "subagent",
      "hidden": true,
      "permission": {
        "read": "deny",
        "edit": "deny",
        "glob": "deny",
        "grep": "deny",
        "list": "deny",
        "bash": "deny",
        "task": "deny",
        "webfetch": "deny",
        "websearch": "deny",
        "todowrite": "deny",
        "skill": "deny",
        "review_verdict": "allow"
      }
    }
  }
  ```

  `review-gate` has no `prompt` override on purpose — it's the internal session `llm-review-gate` (step 5) uses for an ALLOW/BLOCK verdict, and must not inherit `system-prompt.txt`'s coding-agent persona (a `system` field is appended after `prompt`, not a replacement for it, so without this dedicated agent the review would compete with that persona for the model's attention). `review_verdict` is the plugin's custom tool for recording that verdict as a function call — denied globally so `build`/`plan`/`general` never see it, re-allowed only inside `review-gate`'s own `permission` block. **Don't "fix" this apparent contradiction (deny at top level, allow inside one agent) — it's intentional.**

  If an `"agent"` key already exists with other agents configured, merge `build`/`plan`/`general`/`review-gate` into it rather than replacing the whole key; same for `"permission"` if one already exists. Produce valid JSON and verify it parses (e.g. `python -c "import json,sys; json.load(open(sys.argv[1]))" "$CONFIG_DIR/opencode.json"` or equivalent) before moving on.

## 3. Point the models.dev catalog at a local file

This machine has no internet, so opencode's hourly background refresh of its models.dev metadata catalog can never succeed here — harmless on its own (non-blocking, fails silently), but writes a failed-fetch log line every hour forever. Not required either way: this setup's Qwen provider is defined by hand in `opencode.json`, not looked up from that catalog.

To silence it with fresher data than the snapshot baked into the offline build at compile time, copy this repo's `deploy/models-dev-snapshot.json` (captured from `opencode models --refresh` on a machine with internet) into place and set both environment variables persistently on this machine (e.g. `~/.bashrc`, or a Windows user/system env var — there's no JSON config key for either). Both are required together: `OPENCODE_MODELS_PATH` alone only affects the first read at startup — the hourly background refresh checks the cache directory's file age instead, not this path, so without `OPENCODE_DISABLE_MODELS_FETCH` too it would still attempt a fetch every 60 minutes:

```bash
cp "$SRC_DIR/deploy/models-dev-snapshot.json" "$CONFIG_DIR/models-dev-snapshot.json"
```

```bash
OPENCODE_MODELS_PATH="$CONFIG_DIR/models-dev-snapshot.json"
OPENCODE_DISABLE_MODELS_FETCH=1
```

## 4. Install the viewer plugin

This lets you actually see what gets sent to the model — a JSON-valid `opencode.json` doesn't guarantee the override actually took effect at runtime, and this is the only way to check. Published as a real npm package, `@kealthas-dev/opencode-system-prompt-tools` — opencode's own npm-plugin loader installs it itself, no manual packaging or cache-seeding needed. If step 2 copied `deploy/opencode.json.example` fresh (the "does NOT exist yet" branch), this entry — along with step 5's two plugins — is already in there by default; skip straight to the verification note below unless you want to remove one. Otherwise (the more likely case — you merged into an existing `opencode.json`), add it to `opencode.json`'s top level (merge, don't replace, same rule as step 2), by bare package name, no version:

```json
"plugin": ["@kealthas-dev/opencode-system-prompt-tools"]
```

opencode does a real `npm install` of this on first use, against whatever registry this machine's npm is configured for (this machine's internal registry mirror — confirmed working via steps 6/7's `npm install` calls), and caches the result so later runs skip straight past it. Leaving off a version means every fresh cache picks up whatever's currently tagged `latest` on the registry at install time — it won't silently update again after that first install.

**Important:** `opencode debug config` showing a `plugin_origins` entry is NOT proof the install succeeded — a bad/unreachable package name fails silently (exit 0, no log line) and leaves `$CACHE_DIR/packages/@kealthas-dev/opencode-system-prompt-tools@latest/` permanently empty. The real proof is step 11: does `~/.local/share/opencode/last-system-prompt.txt` exist with the expected content after `opencode run`? If not, check whether that cache directory actually has files in it (`package.json`/`node_modules` = real install; empty = failed) — if empty, delete it by hand and retry rather than assuming the config itself is wrong.

## 5. (Included by default) hook-logger / llm-review-gate plugins

Two more opencode plugins live in this repo, in `plugins/` — general-purpose tooling, unrelated to the prompt override itself. `deploy/opencode.json.example` includes both by default (Franco's call — same template as step 4's plugin). Each is its own separate published npm package, independent of the other, so removing one from the `plugin` array doesn't affect the other:

- `hook-logger.ts` (`@kealthas-dev/opencode-hook-logger`) — logs essentially every opencode hook event (chat, tool execution, permission asks, compaction, etc.) as JSONL under `~/opencode-hook-output/`, for debugging/observability.
- `llm-review-gate.ts` (`@kealthas-dev/opencode-llm-review-gate`) — gates `bash` tool calls behind an LLM safety review: before a command runs, it's sent to a hidden internal opencode session for an ALLOW/BLOCK verdict, layered on top of (not replacing) opencode's own permission config. Fails open on review errors/timeouts by default. **This changes real runtime behavior** (an extra hidden model call before every `bash` call).

If step 2 merged into an existing `opencode.json` rather than copying the example fresh, add these the same way as step 4, same install mechanism:

```json
"plugin": ["@kealthas-dev/opencode-hook-logger", "@kealthas-dev/opencode-llm-review-gate"]
```

Merge into the same `plugin` array as step 4's entry rather than replacing it — `opencode.json`'s `plugin` field accepts multiple entries, and each entry here is independent: include just one by adding just its own array entry above.

## Steps 6-9: the shared MCP server pattern

Steps 6-9 (`oracle`, `loki`, `java-lsp`, `spring-lsp`) all follow the same shape, each published as a real npm package under `@kealthas-dev/opencode-mcp-<name>`:

1. Install globally via the internal npm registry (see this doc's intro for why that registry, not public npm, resolves this) — same mechanism that already makes the `opencode` command itself work on this machine. This puts an `opencode-mcp-<name>` binary on `PATH`. If `npm install` (or a prerequisite check below) unexpectedly fails, report it rather than working around by guessing at a substitute package or how to fix the environment.
2. Each is wired as `type: "remote"` in `opencode.json` (see `mcp-servers/oracle/README.md`'s Design section for why): opencode connects to it as an already-running HTTP endpoint rather than spawning and owning it. The server process has to be started independently, before opencode ever tries to use it — a persistent terminal/session running the binary, a process supervisor, or a container, whichever fits this machine — and left running. opencode itself never starts, stops, or restarts any of these four.
3. Each reads its config from files, not raw environment variables (see the relevant README's Configuration section) — a config file plus a `server.json` for just the port (only needed if the default port below isn't free; an `<X>_MCP_PORT` env var overrides it too, for running more than one instance). The config file's *location* is fixed too, not an arbitrary path: with no `<X>_CONFIG_ENV` env var set (see the table below for the exact name) it's read from `~/.config/kealthas-dev/opencode-mcp-<name>/config.json`; setting `<X>_CONFIG_ENV=prod` reads `config-prod.json` instead, for multi-environment setups.
4. Create the config file yourself — **real values only, never guessed by an executing agent; ask the human running this.**
5. Start the server and leave it running. `oracle`/`loki` re-read their config file on every call, so editing it takes effect without a restart; `java-lsp`/`spring-lsp` read it once at startup (their LSP session is stateful and tied to one workspace) and need a restart after an edit.
6. `deploy/opencode.json.example` already carries all four `mcp` blocks below, enabled, with placeholder ports — only add one by hand if step 2 merged into an existing `opencode.json` instead of copying the example fresh (merge into the top-level `mcp` key, don't replace it).

Per-server specifics:

| | oracle (step 6) | loki (step 7) | java-lsp (step 8) | spring-lsp (step 9) |
|---|---|---|---|---|
| Package | `@kealthas-dev/opencode-mcp-oracle` | `@kealthas-dev/opencode-mcp-loki` | `@kealthas-dev/opencode-mcp-java-lsp` | `@kealthas-dev/opencode-mcp-spring-lsp` |
| Prerequisites | none | none | `python3` + JDK 21+ `java` on `PATH`, separate from whatever JDK the analyzed project targets — neither confirmed present on the actual target machine yet | JDK 21+ `java` on `PATH` (no `python3` needed) |
| Config env var | `ORACLE_CONFIG_ENV` | `LOKI_CONFIG_ENV` | `JAVA_LSP_CONFIG_ENV` | `SPRING_LSP_CONFIG_ENV` |
| Config file keys | `ORACLE_CONNECT_STRING`, `ORACLE_USER`, `ORACLE_PASSWORD` (required); `ORACLE_DEFAULT_SCHEMA` (optional — sets the session's default schema; `oracle_query`'s own `schema` argument overrides it per call) | `LOKI_BASE_URL` (required); `LOKI_USERNAME`/`LOKI_PASSWORD`/`LOKI_ORG_ID` (optional, only if that instance requires them); `LOKI_VIA_GRAFANA`/`LOKI_GRAFANA_DATASOURCE_ID` (optional — set when Loki is only reachable through Grafana's own datasource proxy, not directly; see step 7 below) | `JAVA_LSP_WORKSPACE_ROOT` (project to analyze), `JDTLS_DATA_DIR` (jdtls's own index storage — a scratch dir, not the project root) — both required | `SPRING_LSP_WORKSPACE_ROOT` (project to analyze, required) |
| Default port / override key | `8090` / `ORACLE_MCP_PORT` | `8091` / `LOKI_MCP_PORT` | `8092` / `JAVA_LSP_MCP_PORT` | `8093` / `SPRING_LSP_MCP_PORT` |
| Passthrough / notes | full passthrough, no read-only enforcement, by deliberate design — see `mcp-servers/oracle/README.md` | full passthrough, any LogQL, by deliberate design — see `mcp-servers/loki/README.md` | vendored `jdtls` (Eclipse JDT Language Server) ships inside the npm package — nothing extra to download | vendored `spring-boot-language-server` ships inside the npm package; classpath-aware richness needs pairing with a `java-lsp` jdtls instance via a "classpath listener" not implemented yet — see `mcp-servers/TODO.md` |

## 6. Add the Oracle MCP server

```bash
npm install -g @kealthas-dev/opencode-mcp-oracle
```

Create the config file with real values (see the shared pattern above), then start the server:

```bash
mkdir -p ~/.config/kealthas-dev/opencode-mcp-oracle
cat > ~/.config/kealthas-dev/opencode-mcp-oracle/config.json <<'EOF'
{
  "ORACLE_CONNECT_STRING": "...",
  "ORACLE_USER": "...",
  "ORACLE_PASSWORD": "..."
}
EOF
```

```bash
opencode-mcp-oracle
```

```json
"mcp": {
  "oracle": {
    "type": "remote",
    "url": "http://localhost:8090/mcp",
    "enabled": true
  }
}
```

If port `8090` is taken, write `~/.config/kealthas-dev/opencode-mcp-oracle/server.json` (`{"ORACLE_MCP_PORT": <port>}`) and update the `url` above to match.

## 7. Add the Loki MCP server

```bash
npm install -g @kealthas-dev/opencode-mcp-loki
```

Create the config file with real values (see the shared pattern above), then start the server:

```bash
mkdir -p ~/.config/kealthas-dev/opencode-mcp-loki
cat > ~/.config/kealthas-dev/opencode-mcp-loki/config.json <<'EOF'
{
  "LOKI_BASE_URL": "..."
}
EOF
```

**If Loki has no directly reachable port of its own and the only way in is Grafana's own datasource proxy** — check this first if the config above returns a redirect-to-login error instead of data — point `LOKI_BASE_URL` at Grafana's own URL instead of Loki's, and add `LOKI_VIA_GRAFANA`/`LOKI_GRAFANA_DATASOURCE_ID`/`LOKI_USERNAME`/`LOKI_PASSWORD` (a real Grafana user's Basic Auth, not a Loki credential):

```bash
cat > ~/.config/kealthas-dev/opencode-mcp-loki/config.json <<'EOF'
{
  "LOKI_BASE_URL": "http://<grafana-host>:3000",
  "LOKI_VIA_GRAFANA": true,
  "LOKI_GRAFANA_DATASOURCE_ID": "1",
  "LOKI_USERNAME": "...",
  "LOKI_PASSWORD": "..."
}
EOF
```

See `mcp-servers/loki/README.md`'s Configuration section for the full field list and how to find the datasource ID.

```bash
opencode-mcp-loki
```

```json
"mcp": {
  "loki": {
    "type": "remote",
    "url": "http://localhost:8091/mcp",
    "enabled": true
  }
}
```

If port `8091` is taken, write `~/.config/kealthas-dev/opencode-mcp-loki/server.json` (`{"LOKI_MCP_PORT": <port>}`) and update the `url` above to match.

## 8. Add the java-lsp MCP server

Check the prerequisites first:

```bash
python3 --version
java -version
```

```bash
npm install -g @kealthas-dev/opencode-mcp-java-lsp
```

Create the config file with real values (see the shared pattern above), then start the server:

```bash
mkdir -p ~/.config/kealthas-dev/opencode-mcp-java-lsp
cat > ~/.config/kealthas-dev/opencode-mcp-java-lsp/config.json <<'EOF'
{
  "JAVA_LSP_WORKSPACE_ROOT": "...",
  "JDTLS_DATA_DIR": "..."
}
EOF
```

```bash
opencode-mcp-java-lsp
```

```json
"mcp": {
  "java-lsp": {
    "type": "remote",
    "url": "http://localhost:8092/mcp",
    "enabled": true
  }
}
```

If port `8092` is taken, write `~/.config/kealthas-dev/opencode-mcp-java-lsp/server.json` (`{"JAVA_LSP_MCP_PORT": <port>}`) and update the `url` above to match.

## 9. Add the spring-lsp MCP server

Check the prerequisite first (same as step 8's `java -version`; `python3` is not needed here):

```bash
java -version
```

```bash
npm install -g @kealthas-dev/opencode-mcp-spring-lsp
```

Create the config file with real values (see the shared pattern above), then start the server:

```bash
mkdir -p ~/.config/kealthas-dev/opencode-mcp-spring-lsp
cat > ~/.config/kealthas-dev/opencode-mcp-spring-lsp/config.json <<'EOF'
{
  "SPRING_LSP_WORKSPACE_ROOT": "..."
}
EOF
```

```bash
opencode-mcp-spring-lsp
```

```json
"mcp": {
  "spring-lsp": {
    "type": "remote",
    "url": "http://localhost:8093/mcp",
    "enabled": true
  }
}
```

If port `8093` is taken, write `~/.config/kealthas-dev/opencode-mcp-spring-lsp/server.json` (`{"SPRING_LSP_MCP_PORT": <port>}`) and update the `url` above to match.

## 10. Add the Memory MCP server

Unlike steps 6-9, this isn't a server this repo wrote — it's the official upstream `@modelcontextprotocol/server-memory` package (a local knowledge-graph memory: entities/relations/observations in a JSONL file, keyword search only, no embeddings). See `docs/feature-points/15-opencode-memory-mcp.md` for why this one and not a vector/RAG approach. It's also wired as `type: "local"` (opencode spawns and owns the process itself), unlike steps 6-9's `type: "remote"` — no separate terminal or process supervisor to keep running.

Install it globally via the internal npm registry (same registry steps 6-9 already confirmed works for third-party packages):

```bash
npm install -g @modelcontextprotocol/server-memory
```

This puts an `mcp-server-memory` binary on `PATH` (same mechanism that already makes the `opencode` command itself work on this machine). Deliberately not wired as `npx -y @modelcontextprotocol/server-memory` in `opencode.json` — that would make every opencode startup depend on the internal registry being reachable at that moment; installing once and pointing straight at the resulting binary avoids a live-network dependency on every run.

Pick a stable, absolute path for the memory file — not the package's own default location (a global npm package's directory can move or get wiped on an upgrade). `$CONFIG_DIR` is already this deployment's stable home (same place `system-prompt.txt` landed in step 1):

```bash
MEMORY_FILE_PATH="$CONFIG_DIR/memory.jsonl"
echo "$MEMORY_FILE_PATH"
```

`deploy/opencode.json.example` already carries this same block, enabled, but with no `environment` (the example can't know this machine's `$CONFIG_DIR` in advance) — add that `environment` block to `opencode.json`'s top level (merge, don't replace, same rule as step 2). Substitute the real path you just echoed for `<MEMORY_FILE_PATH>` below:

```json
"mcp": {
  "memory": {
    "type": "local",
    "command": ["mcp-server-memory"],
    "enabled": true,
    "environment": {
      "MEMORY_FILE_PATH": "<MEMORY_FILE_PATH>"
    }
  }
}
```

`deploy/system-prompt.txt`'s `# Memory` section already tells the model when to use this tool (checked at session start, durable facts only) — no extra `AGENTS.md` instructions needed on top of what step 1 already copied in.

This knowledge graph will contain whatever the model decides is worth remembering about the user/project over time — unlike this repo's own git-tracked `memory/`, `$CONFIG_DIR/memory.jsonl` is local machine state, not backed up or version-controlled by anything in this repo. If that's not the durability/privacy tradeoff wanted here, that's a real open decision, not something to guess at — flag it back rather than silently changing where the file lives.

## 11. Verify

Run a trivial request against your actual local model:

```bash
opencode run --model <your-provider>/<your-model> "say hi in one word"
```

If you installed the plugin in step 4, check what actually got sent:

```bash
cat ~/.local/share/opencode/last-system-prompt.txt
```

Confirm: the output should start with the content of `system-prompt.txt` (not the original hand-holding `default.txt` identity paragraph), and should still have an `<env>` block further down with the real working directory/platform/date. If it still looks like the original verbose default, the `agent.prompt` config wasn't picked up — check for a JSON syntax error in `opencode.json` first.

If you installed either plugin (steps 4/5) and `opencode run` errors out instead, that's more likely this machine's `npm install` failing against its registry (network/proxy issue, same class of failure as steps 6-9) than a problem with the prompt override itself — check `opencode debug config` output for a `plugin_origins` entry resolving correctly before assuming the whole setup is broken.

## 12. Cleanup (optional)

`$SRC_DIR` (the extracted zip) and the original zip file can be deleted once `$CONFIG_DIR/system-prompt.txt` and the globally-installed `@kealthas-dev/opencode-mcp-oracle`/`@kealthas-dev/opencode-mcp-loki`/`@kealthas-dev/opencode-mcp-java-lsp`/`@kealthas-dev/opencode-mcp-spring-lsp`/`@modelcontextprotocol/server-memory` (whichever of steps 6-10 were installed — nothing under `$SRC_DIR` to clean up for any of them, they're global installs, not copied-in source trees) are in place — those are the only files that matter going forward. Steps 4/5's plugins install themselves into `$CACHE_DIR/packages/<name>@latest/` the first time opencode runs with them configured — nothing under `$SRC_DIR` to clean up for those either. Ask the human running this before deleting anything, don't assume.

## Report back

State plainly, as a checklist:

- Did `opencode.json` already exist (merged) or get created fresh (copied)?
- Did step 11 confirm the custom prompt is actually being sent? If not, what did the output look like instead?
- Which `plugin` entries got installed (step 4, step 5, both, neither), and did `npm install` against this machine's registry succeed cleanly for them?
- Did steps 6-9's `npm install` succeed against the internal registry? For steps 8/9: were `python3`/JDK 21+ `java` already present, or did they need installing?
- If step 10 was installed: did `npm install -g` put `mcp-server-memory` on `PATH`? Did the model actually call the memory tools during step 11, or does `deploy/system-prompt.txt`'s `# Memory` section need stronger wording for this model?

## Updating steps 6-9's MCP servers later

All four share this repo's one version number and get bumped together on every release, even a package whose own code didn't change (see [docs/npm-publishing.md](docs/npm-publishing.md) for why) — so update all four together rather than tracking which one actually changed. Name them explicitly instead of a blanket `npm update -g`, which would also touch every other global npm package on this machine unrelated to this project.

**Stop whichever of these servers are currently running first.** On Windows especially, `npm install -g` needs to remove/replace the old package's files, and a still-running `opencode-mcp-*` process holds those files locked — updating first and restarting after (the wrong order) fails with an `EPERM`/`rmdir` error, not a clean update. Kill each running `opencode-mcp-*` process, then:

```bash
npm install -g @kealthas-dev/opencode-mcp-oracle @kealthas-dev/opencode-mcp-loki @kealthas-dev/opencode-mcp-java-lsp @kealthas-dev/opencode-mcp-spring-lsp
```

Then re-run each server's same start command from steps 6-9 to pick the update back up. If an `EPERM` happens anyway (a lock survives the killed process, or antivirus is holding the directory open), the leftover is at `%APPDATA%\npm\node_modules\@kealthas-dev\opencode-mcp-<name>` on Windows — delete that directory by hand, then re-run the `npm install -g` command above.
