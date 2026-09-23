# java-lsp mcp server

An MCP server exposing real, semantic Java code-intelligence tools — `java_definition`, `java_references`, `java_hover`, `java_implementation`, `java_document_symbols`, `java_workspace_symbols`, `java_diagnostics` — by spawning and driving a real [jdtls](https://github.com/eclipse-jdtls/eclipse.jdt.ls) (Eclipse JDT Language Server) process over its native LSP stdio protocol. Written in TypeScript (`src/server.ts` + `src/lsp-client.ts` + `src/types/config.ts`, compiled to `dist/` — see Run below), built directly against `@modelcontextprotocol/sdk`, same hand-rolled pattern as `mcp-servers/oracle/`/`mcp-servers/loki/`. Speaks MCP over Streamable HTTP as a persistent process opencode connects to (`type: "remote"`), same shape as those two.

This exists because opencode's own built-in `jdtls` LSP integration only auto-detects a `java` on `PATH` (`which("java")` + a version check) with no way to point it at a different JDK for the actual server process. Owning the spawn logic here means this server decides exactly which `java`/`jdtls` to launch, independent of whatever's on `PATH` for the agent's own shell commands.

## Design, and why it looks the way it does

- **A real LSP client, not a reimplementation of jdtls's semantics.** `src/lsp-client.ts` is a minimal, spec-compliant LSP client over stdio (`Content-Length` framing, JSON-RPC request/response correlation, the `initialize`/`initialized` handshake, `didOpen`/`didChange` document sync). It does none of the actual Java analysis — that's entirely jdtls's job; this just drives the protocol.
- **One persistent jdtls process for the server's whole lifetime, not one per request.** Unlike `mcp-servers/oracle`'s/`mcp-servers/loki`'s deliberately-stateless per-request design, LSP is a genuinely stateful session — project indexing alone takes real time, and jdtls doesn't support concurrent instances against the same `-data` directory. `src/server.ts` keeps one `LspClient` singleton (lazily started on the first tool call) at module scope; the outer MCP/HTTP layer is still stateless-per-request (fresh `Server`/transport pair per call, same as `mcp-servers/oracle`/`mcp-servers/loki`) — those are two independent layers, and only the inner one needed to change.
- **`src/lsp-client.ts` is duplicated into `mcp-servers/spring-lsp/`, not shared via a package dependency.** Both packages need the same framing/handshake/sync engine, verbatim. Rather than introduce a cross-package `file:` dependency (which nothing else under `mcp-servers/` does — each package there is independently installable), the file is copied. See `mcp-servers/spring-lsp/README.md` for the same note from that side.
- **File paths are resolved relative to `JAVA_LSP_WORKSPACE_ROOT` and checked against path traversal** (`resolveFile()` in `src/server.ts`) — a path that escapes the configured workspace root is rejected before ever reaching jdtls or the filesystem.
- **Line/character positions are 0-indexed**, per the LSP spec — not the 1-indexed line numbers most editors display. Documented on every tool's `line`/`character` argument, not just here.

## Vendoring

`jdtls` (eclipse-jdtls/eclipse.jdt.ls, [EPL-2.0](http://www.eclipse.org/legal/epl-2.0)) is vendored here — `vendor/jdt-language-server-*.tar.gz` (committed, ~49MB), Eclipse's own official milestone build from `download.eclipse.org/jdtls/milestones/`, the same distribution channel `brew install jdtls` itself pulls from (checksum verified against Homebrew's own formula at download time). `src/server.ts` extracts it automatically into a sibling directory on first run (gitignored — see the root `.gitignore`); nothing to do manually beyond `npm install`. `bin/jdtls` inside the extracted distribution is Eclipse's own Python launcher script, not a single binary — **needs `python3` on `PATH`** in addition to the JDK below. See `fetch-jdtls.sh` to reproduce or refresh it; `JDTLS_COMMAND` still overrides this entirely, e.g. to point at a separately-installed `jdtls` instead (`brew install jdtls` or otherwise).

## JDK version

jdtls itself needs a JDK 21+ runtime to launch — that's a property of whatever launches it (its `JAVA_HOME`), completely separate from what your actual project needs to compile/run against. If your project targets an older Java version, set `JAVA_EXECUTABLE` (jdtls's own `--java-executable` flag) to point jdtls at the JDK your project should be analyzed with, without touching the JDK that launches jdtls itself or your shell's default `java` on `PATH` — see the intro above for why that separation is the whole point of this package existing as a standalone MCP server.

This package is verified against the vendored `jdtls` 1.61.0 above (see Vendoring). Vendoring the jdtls distribution itself doesn't remove the JDK-21+-to-launch-it requirement — a system `java` still needs to be on `PATH` (or however the process supervisor provides one); see SETUP.md step 8.

## Configuration

Config is file-based, not env-var-based — same two-file split as `mcp-servers/oracle/` (see its README's Configuration section for the fullest writeup of the pattern):

- **`$HOME/.config/kealthas-dev/opencode-mcp-java-lsp/server.json`** — the port to listen on, at this one fixed path always. Optional: if missing, defaults to `8092`; if present, must be valid JSON or the server refuses to start. Shape (see `server.example.json`):
  ```json
  { "JAVA_LSP_MCP_PORT": 8092 }
  ```
- **A config file at whatever path the `JAVA_LSP_CONFIG_FILE` env var points at** — filename and location are unrestricted, so one install can be pointed at a different project just by changing this one env var. Required — the server prints a sample and exits if `JAVA_LSP_CONFIG_FILE` is unset, the file doesn't exist, or `JAVA_LSP_WORKSPACE_ROOT`/`JDTLS_DATA_DIR` is missing from it. Shape (see `config.example.json`):
  ```json
  {
    "JAVA_LSP_WORKSPACE_ROOT": "/path/to/your/java/project",
    "JDTLS_DATA_DIR": "/path/to/a/scratch/dir/jdtls-data",
    "JDTLS_COMMAND": "/path/to/some/other/jdtls",
    "JAVA_EXECUTABLE": "/path/to/jdk8/bin/java"
  }
  ```
  `JAVA_LSP_WORKSPACE_ROOT` — absolute path to the Java project jdtls should analyze. `JDTLS_DATA_DIR` — jdtls's own workspace/index storage directory (its `-data` flag), **not** the project root; dedicate one per project — jdtls refuses to share a `-data` dir across concurrently-running instances for different projects. `JDTLS_COMMAND` — optional, the jdtls launcher, defaults to the vendored jdtls above. `JAVA_EXECUTABLE` — optional, see "JDK version" above.

## Run

Published as `@kealthas-dev/opencode-mcp-java-lsp` — on a real deployment, install it globally and run the resulting binary:

```bash
npm install -g @kealthas-dev/opencode-mcp-java-lsp
JAVA_LSP_CONFIG_FILE=~/.config/kealthas-dev/opencode-mcp-java-lsp/configs/my-project.json opencode-mcp-java-lsp
```

For local dev/testing against this repo's own checkout (this directory, not the published package), point `JAVA_LSP_CONFIG_FILE` at a real config file (see `config.example.json` for the shape):

```bash
npm install
npm run build
JAVA_LSP_CONFIG_FILE=/path/to/a/real/config.json npm start
```

`npm run dev` runs `src/server.ts` directly via `tsx watch` instead, for a compile-on-save loop.

Either way, point opencode at it with a `type: "remote"` entry (see `deploy/opencode.json.example`) — it needs to already be running and stay running, since opencode connects rather than spawns it.

## Status

**Verified end-to-end against a real jdtls, both manually and by `java-lsp.test.ts`.** All seven tools were run against a real jdtls 1.61.0 process (the vendored one above) and a small real Java file, confirming: `initialize` handshake succeeds; `java_document_symbols` returns the real parsed class/methods (not text matches); `java_hover` returns the real resolved type signature; `java_references` finds the real declaration + call site (2 results, not a name-text grep's false positives); `java_definition`/`java_implementation` resolve real cross-references; `java_workspace_symbols` fuzzy-matches the real symbol index; `java_diagnostics` returns a real compiler diagnostic (a genuine package-mismatch warning from the test fixture, confirming this isn't a stubbed-empty response). `java-lsp.test.ts` covers four of these (`java_document_symbols`, `java_hover`, `java_references`, `java_workspace_symbols`) as automated assertions, plus a path-traversal rejection check — `java_definition`/`java_implementation`/`java_diagnostics` are only verified manually, above.

**Not yet wired into `tests/run-in-container.sh` / the docker/ sandbox** — the sandbox's base image has no JDK, and adding one needs explicit sign-off, same as any new download source (see `mcp-servers/TODO.md`). Run `java-lsp.test.ts` directly on a machine with a JDK 21+ `java`, `python3`, and (for now) a `jdtls` binary on `PATH` (e.g. `brew install jdtls`) — the test's own preflight check still requires one on `PATH`, even though the server process it spawns launches the vendored copy regardless of what that check finds. A real deployment (SETUP.md step 8) only needs the JDK and `python3`; the vendored jdtls handles the rest there.

**Not tested:** a real multi-file/Maven/Gradle project (only a single loose `.java` file was used — jdtls's cross-file resolution across a real dependency graph should work the same way in principle, since that's exactly what jdtls itself is for, but wasn't specifically exercised here). Concurrent tool calls while jdtls is still indexing a large project. Behavior once `JDTLS_DATA_DIR` already has a populated index from a previous run.
