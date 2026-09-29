# spring-lsp mcp server

An MCP server exposing Spring-aware code-intelligence tools — `spring_hover`, `spring_completion`, `spring_document_symbols`, `spring_workspace_symbols`, `spring_diagnostics`, `spring_boot_structure` — by spawning and driving a real [`spring-boot-language-server`](https://github.com/spring-projects/sts4) process (VMware/Spring's own LSP implementation, the same one their VS Code "Spring Boot Tools" extension uses) over its native LSP stdio protocol. Written in TypeScript (`src/server.ts` + `src/lsp-client.ts` + `src/types/config.ts`, compiled to `dist/` — see Run below). Same hand-rolled-against-`@modelcontextprotocol/sdk` pattern and `type: "remote"` deployment shape as `mcp-servers/oracle/`/`mcp-servers/loki/`/`mcp-servers/java-lsp/` — see `mcp-servers/java-lsp/README.md` for the shared design notes (persistent singleton LSP session, stateless-per-request MCP/HTTP layer, `lsp-client.ts` duplicated between the two packages rather than shared as a dependency).

This exists because generic Java tooling (jdtls, and opencode's own built-in `jdtls` LSP integration) has no notion of Spring's dependency-injection/annotation-driven wiring — `@Autowired` interface fields resolve to the interface, not the actual injected bean; `@EventListener`/`@Scheduled`/`@RequestMapping` handler methods show zero references even though the framework calls them via reflection; `application.properties`/`.yml` are invisible to it entirely. `spring-boot-language-server` is Spring's own answer to that gap.

## Vendoring

`spring-boot-language-server` isn't published to Maven Central or any other package registry — confirmed against [its own project's FAQ](https://github.com/spring-projects/spring-tools/wiki/FAQ). The only distribution channel is VMware's "Spring Boot Tools" VS Code extension, whose `.vsix` bundles it. `vendor/spring-boot-language-server-*.tar.gz` (committed, **~81MB**) is that jar plus the ~170-jar `lib/` directory its `MANIFEST.MF`'s `Class-Path` requires alongside it — this is a full embedded Spring Boot 4 application (Tomcat, the real Eclipse JDT core, OpenRewrite, jgit, ...), not a single-file fat jar, so both have to ship together. `src/server.ts` extracts it automatically into a sibling directory on first run (gitignored — see the root `.gitignore`); nothing to do manually beyond `npm install`.

**This is, by a wide margin, the largest binary in this repository** (existing precedent — the `plugins/*/*.tgz` tarballs — are ~4KB each; this is ~20,000x that). It permanently adds ~81MB to every future clone, and removing it later would not shrink git history without a rewrite. See `fetch-spring-boot-language-server.sh` to reproduce or refresh it.

## JDK version

`spring-boot-language-server` itself needs a **JDK 21+** runtime — confirmed directly from the vendored 2.5.0-SNAPSHOT build's own `MANIFEST.MF` (`Java-Version: 21`), not from older STS4 docs (which say 11+ for older releases — this build has moved past that). Set `KEALTHAS_SPRING_LSP_LAUNCHER_JAVA_EXECUTABLE` if the `java` on `PATH` isn't 21+; this is separate from whatever JDK your actual Spring Boot project targets.

## Configuration

Config is file-based, not env-var-based — same two-file split as `mcp-servers/oracle/` (see its README's Configuration section for the fullest writeup of the pattern):

- **`$HOME/.config/kealthas-dev/opencode-mcp-spring-lsp/server.json`** — the port to listen on. `SPRING_LSP_MCP_PORT` env var overrides it, for running more than one instance (one per project, say). Otherwise optional: if missing, defaults to `8093`; if present, must be valid JSON or the server refuses to start. Shape (see `server.example.json`):
  ```json
  { "SPRING_LSP_MCP_PORT": 8093 }
  ```
- **A config file, read once at startup** (unlike `mcp-servers/oracle`/`mcp-servers/loki`, not re-read per call - the LSP session is stateful and tied to one workspace, so switching config means restarting the process). The *location* it's read from is never user-supplied — only a short environment/project name is, via `SPRING_LSP_CONFIG_ENV`; see `mcp-servers/oracle/README.md`'s Configuration section for why. With no `SPRING_LSP_CONFIG_ENV` set, it's read from `config.json`; with `SPRING_LSP_CONFIG_ENV=my-project`, from `config-my-project.json` instead. Required (one file or the other must exist) — the server prints a sample and exits if the resolved file doesn't exist or `SPRING_LSP_WORKSPACE_ROOT` is missing from it. Shape (see `config.example.json`):
  ```json
  {
    "SPRING_LSP_WORKSPACE_ROOT": "/path/to/your/spring-boot/project",
    "KEALTHAS_SPRING_LSP_LAUNCHER_JAVA_EXECUTABLE": "/path/to/jdk21/bin/java",
    "KEALTHAS_SPRING_LSP_MAVEN_COMMAND": "/path/to/mvn"
  }
  ```
  `SPRING_LSP_WORKSPACE_ROOT` — absolute path to the Spring Boot project to analyze. `KEALTHAS_SPRING_LSP_LAUNCHER_JAVA_EXECUTABLE` — optional, see "JDK version" above; defaults to whatever `java` resolves to on `PATH`. `KEALTHAS_SPRING_LSP_MAVEN_COMMAND` — optional, the Maven used to compute the project's classpath (see "Classpath" below); defaults to `mvn` on `PATH`. On Windows, write these paths with forward slashes (`C:/Users/you/project`) rather than backslashes — Node accepts both, and forward slashes need no escaping in JSON (an unescaped `C:\Users\...` breaks `JSON.parse` with a cryptic error).

## Run

See [docs/java-lsp-spring-lsp-quickstart.zh.md](../../docs/java-lsp-spring-lsp-quickstart.zh.md) for a bare-minimum copy-paste version of the local-dev path below.

Published as `@kealthas-dev/opencode-mcp-spring-lsp` (including the vendored tarball above — a global install is fully self-contained) — on a real deployment, install it globally and run the resulting binary:

```bash
npm install -g @kealthas-dev/opencode-mcp-spring-lsp
mkdir -p ~/.config/kealthas-dev/opencode-mcp-spring-lsp
# real config at ~/.config/kealthas-dev/opencode-mcp-spring-lsp/config-my-project.json (see config.example.json for the shape)
SPRING_LSP_CONFIG_ENV=my-project opencode-mcp-spring-lsp
```

For local dev/testing against this repo's own checkout (this directory, not the published package), same idea — drop a real config file at the default location, or a named `config-<name>.json` (see `config.example.json` for the shape):

```bash
npm install
npm run build
npm start   # reads ~/.config/kealthas-dev/opencode-mcp-spring-lsp/config.json
```

`npm run dev` runs `src/server.ts` directly via `tsx watch` instead, for a compile-on-save loop.

Either way, point opencode at it with a `type: "remote"` entry (see `deploy/opencode.json.example`).

## Classpath

`spring-boot-language-server` does not work out the project's classpath itself. Right after startup it sends its client a custom `sts/addClasspathListener` request and waits for the client to call back the command id it registered with the project's classpath (VS Code's Java extension does this for it). Nothing here plays that role except this package: `src/classpath.ts` runs Maven's `dependency:build-classpath` once, in the background as soon as the server process starts, and builds the event the server expects (the dependency jars, the JDK's `jrt-fs.jar` as the system library, and the project's `src/main` / `src/test` source folders); `src/server.ts` starts the language server only after that is ready and answers its request by calling the command back with it. The event has to arrive within the language server's ~15s wait or it is dropped for the process's lifetime, hence the ordering; a slow first Maven run (tens of seconds while plugins resolve) therefore delays the first tool call rather than emptying its result.

Maven projects only (`pom.xml` at `SPRING_LSP_WORKSPACE_ROOT`). Without one, or when the Maven run fails (a message is written to stderr), the server gets no classpath and every tool answers empty after its ~15s wait.

## Status

**Protocol plumbing verified end-to-end against the real, vendored `spring-boot-language-server` 2.5.0-SNAPSHOT** — both manually and by `spring-lsp.test.ts`: the `initialize` handshake succeeds; the auto-extraction of the vendored tarball works; `.java`/`.properties` files can be opened and synced; `spring_boot_structure`'s real `sts/spring-boot/structure` custom command round-trips cleanly; `spring_diagnostics`/`spring_completion` on a `.properties` file return cleanly without crashing the server. The fuller client-capabilities object in `src/lsp-client.ts` is required for this server; keep the `defaultClientCapabilities()` comment if editing it.

**Verified on Windows 10 (Git Bash, JDK 21):** first-run extraction from a clean checkout and all of `spring-lsp.test.ts` pass. The vendored tarball carries macOS `._*` AppleDouble files that GNU tar extracts as ordinary files, so `server.ts` skips them when locating the exec jar; `fetch-spring-boot-language-server.sh` packs with `COPYFILE_DISABLE=1` so a refreshed tarball won't have them. On Windows, run it from Git Bash (extraction needs `mkdir`/`tar` from `PATH`, with forward-slash paths).

**Verified against a real Spring Boot 3.3.4 Maven project (macOS, JDK 21, Maven 3.9)** with its dependencies resolved and compiled (so `shop.*` from a `@ConfigurationProperties` class has generated metadata): `spring_diagnostics` flags an unknown property, `spring_completion` proposes `shop.max-items` and friends, `spring_hover` returns a property's default and description (`server.port`, and `shop.name` from the project's own javadoc), `spring_document_symbols` returns the Spring view of a controller (`@+ 'helloController' (@RestController <: @Controller, @Component)`, `@/api/hello -- GET`), and `spring_workspace_symbols` finds `/api` endpoints; all in well under a second once the language server is up. `spring_boot_structure` and hovering an annotation such as `@GetMapping` return empty: those describe a running Spring Boot app, which is not started here. Not yet run on Windows: there `mvn` is `mvn.cmd`, which this package runs through a shell.

**Not yet wired into `tests/run-in-container.sh` / the docker/ sandbox** — same reason as `mcp-servers/java-lsp` (no JDK in the sandbox's base image; see that package's README). Run `spring-lsp.test.ts` directly on a machine with a JDK 21+ `java` for now.

**To see this server's Spring-specific value on your own project**, point `SPRING_LSP_WORKSPACE_ROOT` at a Maven Spring Boot project, and run `mvn compile` once so the project's own `@ConfigurationProperties` have generated metadata (`target/classes/META-INF/spring-configuration-metadata.json`, from `spring-boot-configuration-processor`); properties of the starters themselves (`server.port` and so on) work without it.
