# spring-lsp mcp server

An MCP server exposing Spring-aware code-intelligence tools — `spring_hover`, `spring_completion`, `spring_document_symbols`, `spring_workspace_symbols`, `spring_diagnostics`, `spring_boot_structure` — by spawning and driving a real [`spring-boot-language-server`](https://github.com/spring-projects/sts4) process (VMware/Spring's own LSP implementation, the same one their VS Code "Spring Boot Tools" extension uses) over its native LSP stdio protocol. Written in TypeScript (`src/server.ts` + `src/lsp-client.ts` + `src/types/config.ts`, compiled to `dist/` — see Run below). Same hand-rolled-against-`@modelcontextprotocol/sdk` pattern and `type: "remote"` deployment shape as `mcp-servers/oracle/`/`mcp-servers/loki/`/`mcp-servers/java-lsp/` — see `mcp-servers/java-lsp/README.md` for the shared design notes (persistent singleton LSP session, stateless-per-request MCP/HTTP layer, `lsp-client.ts` duplicated between the two packages rather than shared as a dependency).

This exists because generic Java tooling (jdtls, and opencode's own built-in `jdtls` LSP integration) has no notion of Spring's dependency-injection/annotation-driven wiring — `@Autowired` interface fields resolve to the interface, not the actual injected bean; `@EventListener`/`@Scheduled`/`@RequestMapping` handler methods show zero references even though the framework calls them via reflection; `application.properties`/`.yml` are invisible to it entirely. `spring-boot-language-server` is Spring's own answer to that gap.

## Vendoring

`spring-boot-language-server` isn't published to Maven Central or any other package registry — confirmed against [its own project's FAQ](https://github.com/spring-projects/spring-tools/wiki/FAQ). The only distribution channel is VMware's "Spring Boot Tools" VS Code extension, whose `.vsix` bundles it. `vendor/spring-boot-language-server-*.tar.gz` (committed, **~81MB**) is that jar plus the ~170-jar `lib/` directory its `MANIFEST.MF`'s `Class-Path` requires alongside it — this is a full embedded Spring Boot 4 application (Tomcat, the real Eclipse JDT core, OpenRewrite, jgit, ...), not a single-file fat jar, so both have to ship together. `src/server.ts` extracts it automatically into a sibling directory on first run (gitignored — see the root `.gitignore`); nothing to do manually beyond `npm install`.

**This is, by a wide margin, the largest binary in this repository** (existing precedent — the `plugins/*/*.tgz` tarballs — are ~4KB each; this is ~20,000x that). It permanently adds ~81MB to every future clone, and removing it later would not shrink git history without a rewrite. See `fetch-spring-boot-language-server.sh` to reproduce or refresh it.

## JDK version

`spring-boot-language-server` itself needs a **JDK 21+** runtime — confirmed directly from the vendored 2.5.0-SNAPSHOT build's own `MANIFEST.MF` (`Java-Version: 21`), not from older STS4 docs (which say 11+ for older releases — this build has moved past that). Set `JAVA_EXECUTABLE` if the `java` on `PATH` isn't 21+; this is separate from whatever JDK your actual Spring Boot project targets.

## Configuration

Config is file-based, not env-var-based — same two-file split as `mcp-servers/oracle/` (see its README's Configuration section for the fullest writeup of the pattern):

- **`$HOME/.config/kealthas-dev/opencode-mcp-spring-lsp/server.json`** — the port to listen on, at this one fixed path always. Optional: if missing, defaults to `8093`; if present, must be valid JSON or the server refuses to start. Shape (see `server.example.json`):
  ```json
  { "SPRING_LSP_MCP_PORT": 8093 }
  ```
- **A config file at whatever path the `SPRING_LSP_CONFIG_FILE` env var points at** — filename and location are unrestricted. Required — the server prints a sample and exits if `SPRING_LSP_CONFIG_FILE` is unset, the file doesn't exist, or `SPRING_LSP_WORKSPACE_ROOT` is missing from it. Shape (see `config.example.json`):
  ```json
  {
    "SPRING_LSP_WORKSPACE_ROOT": "/path/to/your/spring-boot/project",
    "JAVA_EXECUTABLE": "/path/to/jdk21/bin/java"
  }
  ```
  `SPRING_LSP_WORKSPACE_ROOT` — absolute path to the Spring Boot project to analyze. `JAVA_EXECUTABLE` — optional, see "JDK version" above; defaults to whatever `java` resolves to on `PATH`.

## Run

Published as `@kealthas-dev/opencode-mcp-spring-lsp` (including the vendored tarball above — a global install is fully self-contained) — on a real deployment, install it globally and run the resulting binary:

```bash
npm install -g @kealthas-dev/opencode-mcp-spring-lsp
SPRING_LSP_CONFIG_FILE=~/.config/kealthas-dev/opencode-mcp-spring-lsp/configs/my-project.json opencode-mcp-spring-lsp
```

For local dev/testing against this repo's own checkout (this directory, not the published package), point `SPRING_LSP_CONFIG_FILE` at a real config file (see `config.example.json` for the shape):

```bash
npm install
npm run build
SPRING_LSP_CONFIG_FILE=/path/to/a/real/config.json npm start
```

`npm run dev` runs `src/server.ts` directly via `tsx watch` instead, for a compile-on-save loop.

Either way, point opencode at it with a `type: "remote"` entry (see `deploy/opencode.json.example`).

## Status

**Protocol plumbing verified end-to-end against the real, vendored `spring-boot-language-server` 2.5.0-SNAPSHOT** — both manually and by `spring-lsp.test.mjs`: the `initialize` handshake succeeds; the auto-extraction of the vendored tarball works; `.java`/`.properties` files can be opened and synced; `spring_boot_structure`'s real `sts/spring-boot/structure` custom command round-trips cleanly; `spring_diagnostics`/`spring_completion` on a `.properties` file return cleanly without crashing the server. The fuller client-capabilities object in `src/lsp-client.ts` is required for this server; keep the `defaultClientCapabilities()` comment if editing it.

**Not verified: actual Spring-aware semantic richness.** Every tool call in testing was run against a bare loose `.java` file + `application.properties` with no real Maven/Gradle project and no resolved `spring-boot-starter-*` dependencies — against that fixture, every one of this server's own richer results (`spring_hover`/`spring_completion` finding real config properties, `spring_boot_structure` finding real beans, even plain `spring_document_symbols`) comes back an **empty array**, not an error. Two known reasons:

1. **No real Spring Boot dependencies on the classpath** — `spring_hover`/`spring_completion`'s config-property awareness comes from the project's own resolved `spring-configuration-metadata.json` (inside its actual `spring-boot-starter-*` jars). A fixture project with no such dependencies has none to offer.
2. **This server expects a paired jdtls providing classpath/project info via a "classpath listener" mechanism**, which VS Code's Java extension pack wires up between its `redhat.java` (jdtls) and `vmware.vscode-spring-boot` extensions. Standalone, `SpringSymbolIndex`/`JdtLsProjectCache` time out waiting for that listener (visible directly in this server's own stderr logs: `TimeoutException ... at SpringSymbolIndex.getDocumentSymbolsFromMetamodelIndex`) and degrade to empty results rather than erroring. **This pairing is not implemented in this package** — `mcp-servers/java-lsp`'s separate jdtls process and this one currently run fully independently, each unaware of the other. Wiring them together (so `spring_*` tools get real classpath-aware results) is real follow-up work, not attempted here — see `mcp-servers/TODO.md`.

**Not yet wired into `tests/run-in-container.sh` / the docker/ sandbox** — same reason as `mcp-servers/java-lsp` (no JDK in the sandbox's base image; see that package's README). Run `spring-lsp.test.mjs` directly on a machine with a JDK 21+ `java` for now.

**To actually see this server's Spring-specific value**, point `SPRING_LSP_WORKSPACE_ROOT` at a real Maven/Gradle Spring Boot project with its dependencies already resolved (`mvn dependency:resolve` / a completed Gradle sync) — not attempted here, and the classpath-listener gap above may still limit results even then.
