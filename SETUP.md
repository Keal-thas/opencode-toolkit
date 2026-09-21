# Setup instructions (for an agent to execute)

You are being asked to configure the local opencode installation on this machine to use a custom system prompt instead of the built-in default. This environment is git-bash on Windows with no public internet access (an internal npm registry is reachable for downloading dependencies, e.g. in steps 6-9 — but not for publishing anything). The repo itself gets here one of two ways: (a) downloaded elsewhere as a zip and transferred over, already extracted, or (b) pulled directly through the internal npm mirror with `npm pack @kealthas-dev/opencode-toolkit` and extracted (`tar -xzf kealthas-dev-opencode-toolkit-*.tgz`), landing in a `package/` directory. The npm flow depends on `@kealthas-dev/opencode-toolkit` already being published and mirrored internally; verify that first if using option (b). Either way you end up with one plain extracted directory; step 0 below just needs to find it, whichever name it has. Do not attempt `git clone` or any other network fetch beyond that. Follow these steps in order, running the commands yourself. Don't skip the verification step.

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

  `review-gate` has no `prompt` override on purpose — it's the internal session the `llm-review-gate` plugin (step 5) uses to get an ALLOW/BLOCK verdict, and it must NOT inherit `build`/`plan`/`general`'s `system-prompt.txt` persona (an agent's per-request `system` field is appended after its configured `prompt`, not a replacement for it, so without this dedicated agent the review call would be fighting the full coding-agent persona for the model's attention). `review_verdict` is a custom tool the plugin registers for recording that verdict as a real function call rather than free text — a plugin-registered tool is available to every agent by name like a built-in one, so the top-level `permission.review_verdict: "deny"` keeps it out of `build`/`plan`/`general`'s toolset, and `review-gate`'s own `permission` overrides that back to `"allow"` — the only agent that should ever see or call it.

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

**Important:** `opencode debug config` showing a `plugin_origins` entry for this spec is NOT proof the install actually succeeded — a bad/unreachable package name fails completely silently (exit 0, no log line, a `plugin_origins` entry that looks identical to a real success) and leaves behind a permanently-empty `$CACHE_DIR/packages/@kealthas-dev/opencode-system-prompt-tools@latest/` that will never retry on its own. The real proof is step 11's check: after `opencode run`, does `~/.local/share/opencode/last-system-prompt.txt` actually exist and contain the expected content? If not, check whether `$CACHE_DIR/packages/@kealthas-dev/opencode-system-prompt-tools@latest/` actually has files in it (a real install has `package.json`/`node_modules`; a failed one is empty) — if it's empty, delete that directory by hand and retry rather than assuming the plugin config itself is wrong.

## 5. (Included by default) hook-logger / llm-review-gate plugins

Two more opencode plugins live in this repo, in `plugins/` — general-purpose tooling, unrelated to the prompt override itself. `deploy/opencode.json.example` includes both by default (Franco's call — same template as step 4's plugin). Each is its own separate published npm package, independent of the other, so removing one from the `plugin` array doesn't affect the other:

- `hook-logger.ts` (`@kealthas-dev/opencode-hook-logger`) — logs essentially every opencode hook event (chat, tool execution, permission asks, compaction, etc.) as JSONL under `~/opencode-hook-output/`, for debugging/observability.
- `llm-review-gate.ts` (`@kealthas-dev/opencode-llm-review-gate`) — gates `bash` tool calls behind an LLM safety review: before a command runs, it's sent to a hidden internal opencode session for an ALLOW/BLOCK verdict, layered on top of (not replacing) opencode's own permission config. Fails open on review errors/timeouts by default. **This changes real runtime behavior** (an extra hidden model call before every `bash` call).

If step 2 merged into an existing `opencode.json` rather than copying the example fresh, add these the same way as step 4, same install mechanism:

```json
"plugin": ["@kealthas-dev/opencode-hook-logger", "@kealthas-dev/opencode-llm-review-gate"]
```

Merge into the same `plugin` array as step 4's entry rather than replacing it — `opencode.json`'s `plugin` field accepts multiple entries, and each entry here is independent: include just one by adding just its own array entry above.

## 6. Add the Oracle MCP server

Published as a real npm package, `@kealthas-dev/opencode-mcp-oracle` — install it globally via the internal npm registry (see this doc's intro for why that registry, not public npm, resolves this), same mechanism that already makes the `opencode` command itself work on this machine:

```bash
npm install -g @kealthas-dev/opencode-mcp-oracle
```

This puts an `opencode-mcp-oracle` binary on `PATH`. If `npm install` unexpectedly fails here, report it rather than working around by guessing at a substitute package or an unofficial mirror.

The Oracle MCP server is wired as `type: "remote"` in `opencode.json` (see `mcp-servers/oracle/README.md`'s Design section for why): opencode connects to it as an already-running HTTP endpoint rather than spawning and owning it. The server process has to be started independently, before opencode ever tries to use it — a persistent terminal/session running the binary, a process supervisor, or a container, whichever fits this machine. opencode itself never starts, stops, or restarts it.

Start the server with the real Oracle credentials as environment variables (`ORACLE_CONNECT_STRING`, `ORACLE_USER`, `ORACLE_PASSWORD` — see `mcp-servers/oracle/README.md`'s Configuration section), and `ORACLE_MCP_PORT` too if the default port (`8090`) isn't free — however the process supervisor chosen above lets you set environment variables (there's no longer a project directory for a `.env` file to live next to, since this is a global install, not a copied-in source tree):

```bash
ORACLE_CONNECT_STRING=... ORACLE_USER=... ORACLE_PASSWORD=... opencode-mcp-oracle
```

Leave that running (in its own terminal, or under whatever supervisor was chosen above). `deploy/opencode.json.example` already carries this same block, enabled, with a placeholder port — if step 2 merged into an existing `opencode.json` instead of copying the example fresh, add it to `opencode.json`'s top level (merge, don't replace, same rule as step 2):

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

## 7. Add the Loki MCP server

Same shape as step 6: published as `@kealthas-dev/opencode-mcp-loki`, install it globally the same way:

```bash
npm install -g @kealthas-dev/opencode-mcp-loki
```

This puts an `opencode-mcp-loki` binary on `PATH`.

Wired as `type: "remote"` in `opencode.json`, same reasoning as step 6 — opencode connects to an already-running HTTP endpoint, started independently rather than spawned by opencode.

Start the server with `LOKI_BASE_URL` pointing at the real internal Loki instance (see `mcp-servers/loki/README.md`'s Configuration section — `LOKI_USERNAME`/`LOKI_PASSWORD`/`LOKI_ORG_ID` too, only if that Loki instance actually requires them; unlike Oracle's credentials, all of these are optional), and `LOKI_MCP_PORT` if the default port (`8091`) isn't free:

```bash
LOKI_BASE_URL=... opencode-mcp-loki
```

Leave that running (in its own terminal, or under whatever supervisor was chosen in step 6). `deploy/opencode.json.example` already carries this same block, enabled, with a placeholder port — if step 2 merged into an existing `opencode.json` instead of copying the example fresh, add it to `opencode.json`'s top level (merge, don't replace):

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

## 8. Add the java-lsp MCP server

Same install shape as steps 6/7: published as `@kealthas-dev/opencode-mcp-java-lsp`, install it globally the same way. Unlike Oracle/Loki, the vendored `jdtls` (Eclipse JDT Language Server) it drives ships inside the npm package itself (see `mcp-servers/java-lsp/README.md`'s Vendoring section) — nothing extra to download:

```bash
npm install -g @kealthas-dev/opencode-mcp-java-lsp
```

This puts an `opencode-mcp-java-lsp` binary on `PATH`.

**Needs `python3` and a JDK 21+ `java` on `PATH` on this machine** (separate from whatever JDK the Java project being analyzed targets — see the README's JDK version section) — neither has been confirmed present on the actual restricted target machine yet. Check both before relying on this step:

```bash
python3 --version
java -version
```

If either is missing, report that back rather than guessing at how to install one on this machine.

Wired as `type: "remote"` in `opencode.json`, same reasoning as step 6.

Start the server with `JAVA_LSP_WORKSPACE_ROOT` (the Java project to analyze) and `JDTLS_DATA_DIR` (jdtls's own index storage — a scratch directory dedicated to this project, not the project root itself; see `mcp-servers/java-lsp/README.md`'s Configuration section), and `JAVA_LSP_MCP_PORT` if the default port (`8092`) isn't free:

```bash
JAVA_LSP_WORKSPACE_ROOT=... JDTLS_DATA_DIR=... opencode-mcp-java-lsp
```

Leave that running (in its own terminal, or under whatever supervisor was chosen in step 6). `deploy/opencode.json.example` already carries this same block, enabled, with a placeholder port — if step 2 merged into an existing `opencode.json` instead of copying the example fresh, add it to `opencode.json`'s top level (merge, don't replace):

```json
"mcp": {
  "java-lsp": {
    "type": "remote",
    "url": "http://localhost:8092/mcp",
    "enabled": true
  }
}
```

Two things need real values that this repo or an executing agent should never guess — ask the human running this: the real `JAVA_LSP_WORKSPACE_ROOT` (which Java project to analyze), and the port, only if `JAVA_LSP_MCP_PORT` had to be overridden because `8092` was taken.

## 9. Add the spring-lsp MCP server

Same install shape as step 8: published as `@kealthas-dev/opencode-mcp-spring-lsp`, including its own vendored `spring-boot-language-server` (see `mcp-servers/spring-lsp/README.md`'s Vendoring section) — nothing extra to download here either:

```bash
npm install -g @kealthas-dev/opencode-mcp-spring-lsp
```

This puts an `opencode-mcp-spring-lsp` binary on `PATH`.

**Needs a JDK 21+ `java` on `PATH`** (same check as step 8's `java -version`; `python3` is not needed for this one).

Wired as `type: "remote"` in `opencode.json`, same reasoning as step 6.

Start the server with `SPRING_LSP_WORKSPACE_ROOT` (the Spring Boot project to analyze; see `mcp-servers/spring-lsp/README.md`'s Configuration section), and `SPRING_LSP_MCP_PORT` if the default port (`8093`) isn't free:

```bash
SPRING_LSP_WORKSPACE_ROOT=... opencode-mcp-spring-lsp
```

Leave that running. `deploy/opencode.json.example` already carries this same block, enabled, with a placeholder port — if step 2 merged into an existing `opencode.json` instead of copying the example fresh, add it to `opencode.json`'s top level (merge, don't replace):

```json
"mcp": {
  "spring-lsp": {
    "type": "remote",
    "url": "http://localhost:8093/mcp",
    "enabled": true
  }
}
```

One thing needs a real value that this repo or an executing agent should never guess — ask the human running this: the real `SPRING_LSP_WORKSPACE_ROOT` (which Spring Boot project to analyze).

`spring-lsp`'s classpath-aware richness (real bean/config-property results, not empty arrays) needs pairing with a `java-lsp` jdtls instance via a "classpath listener" mechanism that isn't implemented yet — see `mcp-servers/TODO.md`; unrelated to this deployment step.

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

State plainly: did `opencode.json` already exist (merged or created fresh)? Did step 11's verification confirm the custom prompt is actually being sent? If not, what did the actual output look like instead? Which `plugin` entries did you end up installing (step 4, step 5, both, neither), and did opencode's own `npm install` against this machine's registry succeed cleanly for them? Did steps 6-9's `npm install` actually succeed against the internal registry, or was there a real blocker there — and for steps 8/9 specifically, were `python3`/a JDK 21+ `java` actually present on this machine, or did those need installing first? If you installed step 10, did `npm install -g` actually put `mcp-server-memory` on `PATH` the same way it did for `opencode` itself — and separately, did the model actually call the memory tools during step 11's verification, or does `deploy/system-prompt.txt`'s `# Memory` section need stronger wording for this specific model?
