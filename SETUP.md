# Setup instructions (for an agent to execute)

You are being asked to configure the local opencode installation on this machine to use a custom system prompt instead of the built-in default. This environment is git-bash on Windows with no public internet access (an internal npm registry is reachable for downloading dependencies, e.g. in steps 6/7 — but not for publishing anything). The repo itself gets here one of two ways: (a) downloaded elsewhere as a zip and transferred over, already extracted, or (b) pulled directly through the internal npm mirror with `npm pack @kealthas-dev/opencode-toolkit` and extracted (`tar -xzf kealthas-dev-opencode-toolkit-*.tgz`), landing in a `package/` directory. The npm flow depends on `@kealthas-dev/opencode-toolkit` already being published and mirrored internally; verify that first if using option (b). Either way you end up with one plain extracted directory; step 0 below just needs to find it, whichever name it has. Do not attempt `git clone` or any other network fetch beyond that. Follow these steps in order, running the commands yourself. Don't skip the verification step.

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

- **If it already exists** (most likely — your vLLM provider is probably already configured there): read it, then add this exact key to the top-level JSON object, merging with whatever is already there. Do not remove or alter any existing keys (provider config, permissions, etc.) — only add/merge the `agent` key:

  ```json
  "agent": {
    "build": {
      "prompt": "{file:./system-prompt.txt}"
    },
    "plan": {
      "prompt": "{file:./system-prompt.txt}"
    },
    "general": {
      "prompt": "{file:./system-prompt.txt}"
    }
  }
  ```

  If an `"agent"` key already exists with other agents configured, merge `build`/`plan`/`general` into it rather than replacing the whole key. Produce valid JSON and verify it parses (e.g. `python -c "import json,sys; json.load(open(sys.argv[1]))" "$CONFIG_DIR/opencode.json"` or equivalent) before moving on.

## 3. (Optional) Point the models.dev catalog at a local file

This machine has no internet, so opencode's hourly background refresh of its models.dev metadata catalog can never succeed here — harmless on its own (non-blocking, fails silently), but writes a failed-fetch log line every hour forever. Not required either way: this setup's Qwen provider is defined by hand in `opencode.json`, not looked up from that catalog.

To silence it with fresher data than the snapshot baked into the offline build at compile time, copy this repo's `deploy/models-dev-snapshot.json` (captured from `opencode models --refresh` on a machine with internet) into place and set both environment variables persistently on this machine (e.g. `~/.bashrc`, or a Windows user/system env var — there's no JSON config key for either). Both are required together: `OPENCODE_MODELS_PATH` alone only affects the first read at startup — the hourly background refresh checks the cache directory's file age instead, not this path, so without `OPENCODE_DISABLE_MODELS_FETCH` too it would still attempt a fetch every 60 minutes:

```bash
cp "$SRC_DIR/deploy/models-dev-snapshot.json" "$CONFIG_DIR/models-dev-snapshot.json"
```

```bash
OPENCODE_MODELS_PATH="$CONFIG_DIR/models-dev-snapshot.json"
OPENCODE_DISABLE_MODELS_FETCH=1
```

## 4. (Optional but recommended) Install the viewer plugin

This lets you actually see what gets sent to the model — a JSON-valid `opencode.json` doesn't guarantee the override actually took effect at runtime, and this is the only way to check. Published as a real npm package, `@kealthas-dev/opencode-system-prompt-tools` — opencode's own npm-plugin loader installs it itself, no manual packaging or cache-seeding needed. If step 2 copied `deploy/opencode.json.example` fresh (the "does NOT exist yet" branch), this entry — along with step 5's two plugins — is already in there by default; skip straight to the verification note below unless you want to remove one. Otherwise (the more likely case — you merged into an existing `opencode.json`), add it to `opencode.json`'s top level (merge, don't replace, same rule as step 2), by bare package name, no version:

```json
"plugin": ["@kealthas-dev/opencode-system-prompt-tools"]
```

opencode does a real `npm install` of this on first use, against whatever registry this machine's npm is configured for (this machine's internal registry mirror — confirmed working via steps 6/7's `npm install` calls), and caches the result so later runs skip straight past it. Leaving off a version means every fresh cache picks up whatever's currently tagged `latest` on the registry at install time — it won't silently update again after that first install.

**Important:** `opencode debug config` showing a `plugin_origins` entry for this spec is NOT proof the install actually succeeded — a bad/unreachable package name fails completely silently (exit 0, no log line, a `plugin_origins` entry that looks identical to a real success) and leaves behind a permanently-empty `$CACHE_DIR/packages/@kealthas-dev/opencode-system-prompt-tools@latest/` that will never retry on its own. The real proof is step 9's check: after `opencode run`, does `~/.local/share/opencode/last-system-prompt.txt` actually exist and contain the expected content? If not, check whether `$CACHE_DIR/packages/@kealthas-dev/opencode-system-prompt-tools@latest/` actually has files in it (a real install has `package.json`/`node_modules`; a failed one is empty) — if it's empty, delete that directory by hand and retry rather than assuming the plugin config itself is wrong.

## 5. (Included by default) hook-logger / llm-review-gate plugins

Two more opencode plugins live in this repo, in `plugins/` — general-purpose tooling, unrelated to the prompt override itself. `deploy/opencode.json.example` includes both by default (Franco's call — same template as step 4's plugin). Each is its own separate published npm package, independent of the other, so removing one from the `plugin` array doesn't affect the other:

- `hook-logger.ts` (`@kealthas-dev/opencode-hook-logger`) — logs essentially every opencode hook event (chat, tool execution, permission asks, compaction, etc.) as JSONL under `~/opencode-hook-output/`, for debugging/observability.
- `llm-review-gate.ts` (`@kealthas-dev/opencode-llm-review-gate`) — gates `bash` tool calls behind an LLM safety review: before a command runs, it's sent to a hidden internal opencode session for an ALLOW/BLOCK verdict, layered on top of (not replacing) opencode's own permission config. Fails open on review errors/timeouts by default. **This changes real runtime behavior** (an extra hidden model call before every `bash` call) — if that's not wanted, remove `@kealthas-dev/opencode-llm-review-gate` from the `plugin` array before proceeding.

If step 2 merged into an existing `opencode.json` rather than copying the example fresh, add these the same way as step 4, same install mechanism:

```json
"plugin": ["@kealthas-dev/opencode-hook-logger", "@kealthas-dev/opencode-llm-review-gate"]
```

Merge into the same `plugin` array as step 4's entry rather than replacing it — `opencode.json`'s `plugin` field accepts multiple entries, and each entry here is independent: include just one by adding just its own array entry above.

## 6. (Optional) Add the Oracle MCP server

`mcp-servers/oracle/` needs its npm dependencies (`@modelcontextprotocol/sdk`, `oracledb`) installed — this machine has no public internet, but does have a working internal npm registry (a full mirror of public npm), so a plain `npm install` below resolves them from there (this repo doesn't vendor them, unlike the plugins in steps 4/5, which needed no dependencies at all). If `npm install` unexpectedly fails here, report it rather than working around by guessing at a substitute package or an unofficial mirror.

The Oracle MCP server is wired as `type: "remote"` in `opencode.json` (see `mcp-servers/oracle/README.md`'s Design section for why): opencode connects to it as an already-running HTTP endpoint rather than spawning and owning it. The server process has to be started independently, before opencode ever tries to use it — a persistent terminal/session running `npm start`, a process supervisor, or a container, whichever fits this machine. opencode itself never starts, stops, or restarts it.

Copy the server directory in:

```bash
mkdir -p "$CONFIG_DIR/mcp-servers"
cp -r "$SRC_DIR/mcp-servers/oracle" "$CONFIG_DIR/mcp-servers/oracle"
```

Start the server with the real Oracle credentials as environment variables (`ORACLE_CONNECT_STRING`, `ORACLE_USER`, `ORACLE_PASSWORD` — see `mcp-servers/oracle/README.md`'s Configuration section), and `ORACLE_MCP_PORT` too if the default port (`8090`) isn't free:

```bash
cd "$CONFIG_DIR/mcp-servers/oracle" && npm install && npm start
```

Leave that running (in its own terminal, or under whatever supervisor was chosen above), then add this to `opencode.json`'s top level (merge, don't replace, same rule as step 2) — `deploy/opencode.json.example` already carries this same block with a placeholder port, `enabled: false`:

```json
"mcp": {
  "oracle": {
    "type": "remote",
    "url": "http://localhost:8090/mcp",
    "enabled": true
  }
}
```

Two things need real values that this repo or an executing agent should never guess — ask the human running this: the real `ORACLE_CONNECT_STRING`/`ORACLE_USER`/`ORACLE_PASSWORD` for whatever internal Oracle instance this is meant to reach, and the port, only if `ORACLE_MCP_PORT` had to be overridden because `8090` was taken.

`oracle_query` is a full passthrough (no read-only enforcement — see `mcp-servers/oracle/README.md`) by deliberate design, not an oversight; unrelated to this deployment step.

## 7. (Optional) Add the Loki MCP server

Same shape as step 6: `mcp-servers/loki/` needs `@modelcontextprotocol/sdk` installed via `npm install` against the internal registry (one dependency instead of Oracle's two — no driver like `oracledb`, see `mcp-servers/loki/README.md`'s Design section for why).

Wired as `type: "remote"` in `opencode.json`, same reasoning as step 6 — opencode connects to an already-running HTTP endpoint. Copy the directory in:

```bash
mkdir -p "$CONFIG_DIR/mcp-servers"
cp -r "$SRC_DIR/mcp-servers/loki" "$CONFIG_DIR/mcp-servers/loki"
```

Start the server with `LOKI_BASE_URL` pointing at the real internal Loki instance (see `mcp-servers/loki/README.md`'s Configuration section — `LOKI_USERNAME`/`LOKI_PASSWORD`/`LOKI_ORG_ID` too, only if that Loki instance actually requires them; unlike Oracle's credentials, all of these are optional), and `LOKI_MCP_PORT` if the default port (`8091`) isn't free:

```bash
cd "$CONFIG_DIR/mcp-servers/loki" && npm install && npm start
```

Leave that running, then add this to `opencode.json`'s top level (merge, don't replace) — `deploy/opencode.json.example` already carries this same block with a placeholder port, `enabled: false`:

```json
"mcp": {
  "loki": {
    "type": "remote",
    "url": "http://localhost:8091/mcp",
    "enabled": true
  }
}
```

One thing needs a real value that this repo or an executing agent should never guess — ask the human running this: the real `LOKI_BASE_URL` for whatever internal Loki instance this is meant to reach.

`loki_query_range` is a full passthrough (any LogQL, no restriction — see `mcp-servers/loki/README.md`) by deliberate design; unrelated to this deployment step.

## 8. (Optional) Add the Memory MCP server

Unlike steps 6/7, this isn't a server this repo wrote — it's the official upstream `@modelcontextprotocol/server-memory` package (a local knowledge-graph memory: entities/relations/observations in a JSONL file, keyword search only, no embeddings). See `docs/feature-points/15-opencode-memory-mcp.md` for why this one and not a vector/RAG approach. It's also wired as `type: "local"` (opencode spawns and owns the process itself), unlike Oracle/Loki's `type: "remote"` — no separate terminal or process supervisor to keep running.

Install it globally via the internal npm registry (same registry steps 6/7 already confirmed works for third-party packages):

```bash
npm install -g @modelcontextprotocol/server-memory
```

This puts an `mcp-server-memory` binary on `PATH` (same mechanism that already makes the `opencode` command itself work on this machine). Deliberately not wired as `npx -y @modelcontextprotocol/server-memory` in `opencode.json` — that would make every opencode startup depend on the internal registry being reachable at that moment; installing once and pointing straight at the resulting binary avoids a live-network dependency on every run.

Pick a stable, absolute path for the memory file — not the package's own default location (a global npm package's directory can move or get wiped on an upgrade). `$CONFIG_DIR` is already this deployment's stable home (same place `system-prompt.txt` landed in step 1):

```bash
MEMORY_FILE_PATH="$CONFIG_DIR/memory.jsonl"
echo "$MEMORY_FILE_PATH"
```

Add this to `opencode.json`'s top level (merge, don't replace, same rule as step 2) — `deploy/opencode.json.example` already carries this same block with `enabled: false` and no `environment` (the example can't know this machine's `$CONFIG_DIR` in advance). Substitute the real path you just echoed for `<MEMORY_FILE_PATH>` below:

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

## 9. Verify

Run a trivial request against your actual local model:

```bash
opencode run --model <your-provider>/<your-model> "say hi in one word"
```

If you installed the plugin in step 4, check what actually got sent:

```bash
cat ~/.local/share/opencode/last-system-prompt.txt
```

Confirm: the output should start with the content of `system-prompt.txt` (not the original hand-holding `default.txt` identity paragraph), and should still have an `<env>` block further down with the real working directory/platform/date. If it still looks like the original verbose default, the `agent.prompt` config wasn't picked up — check for a JSON syntax error in `opencode.json` first.

If you installed either plugin (steps 4/5) and `opencode run` errors out instead, that's more likely this machine's `npm install` failing against its registry (network/proxy issue, same class of failure as steps 6/7) than a problem with the prompt override itself — check `opencode debug config` output for a `plugin_origins` entry resolving correctly before assuming the whole setup is broken.

## 10. Cleanup (optional)

`$SRC_DIR` (the extracted zip) and the original zip file can be deleted once `$CONFIG_DIR/system-prompt.txt`, `$CONFIG_DIR/mcp-servers/oracle/` (if installed), `$CONFIG_DIR/mcp-servers/loki/` (if installed), and the globally-installed `@modelcontextprotocol/server-memory` (if installed, step 8 — nothing under `$SRC_DIR` to clean up for it either way) are in place — those are the only files that matter going forward. Steps 4/5's plugins install themselves into `$CACHE_DIR/packages/<name>@latest/` the first time opencode runs with them configured — nothing under `$SRC_DIR` to clean up for those either. Ask the human running this before deleting anything, don't assume.

## Report back

State plainly: did `opencode.json` already exist (merged or created fresh)? Did step 9's verification confirm the custom prompt is actually being sent? If not, what did the actual output look like instead? Which `plugin` entries did you end up installing (step 4, step 5, both, neither), and did opencode's own `npm install` against this machine's registry succeed cleanly for them? Did steps 6/7's `npm install` actually succeed against the internal registry, or was there a real blocker there? If you installed step 8, did `npm install -g` actually put `mcp-server-memory` on `PATH` the same way it did for `opencode` itself — and separately, did the model actually call the memory tools during step 9's verification, or does `deploy/system-prompt.txt`'s `# Memory` section need stronger wording for this specific model?
