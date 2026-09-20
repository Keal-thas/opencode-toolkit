# Feature points — opencode-toolkit

A feature-by-feature inventory of this workspace. Index only — details in `feature-points/`. Test coverage notes reference `tests/` (see `tests/README.md` for the canonical, test-focused breakdown). Update this when a feature point is added, removed, or its test coverage changes.

1. [System-prompt override](feature-points/01-prompt-override.md) — replaces opencode's default prompt for build/plan/general. **Tested.**
2. [system-prompt-tools.ts plugin](feature-points/02-system-prompt-tools-plugin.md) — dumps the assembled prompt for inspection. **Tested.**
3. [hook-logger.ts plugin](feature-points/03-hook-logger-plugin.md) — logs every opencode hook event as JSONL. **Tested.**
4. [llm-review-gate.ts plugin](feature-points/04-llm-review-gate-plugin.md) — LLM safety review gating `bash` calls. **Tested.**
5. [Docker dev/test sandbox](feature-points/05-docker-sandbox.md) — isolated container for exercising opencode. **Is the test environment.**
6. [module-analysis toolkit](feature-points/06-module-analysis.md) — batch per-module architecture-doc generator. **Tested.**
7. [models.dev offline catalog handling](feature-points/07-models-dev-offline-catalog.md) — offline-safe models metadata. **Partially tested** (JSON validity only).
8. [Deployment docs](feature-points/08-deployment-docs.md) — SETUP.md + zh walkthrough.
9. [Local opencode docs mirror](feature-points/09-docs-mirror.md) — vendored docs + fetch script. **Syntax-tested only.**
10. [Project memory](feature-points/10-project-memory.md) — git-tracked cross-machine memory. **Not applicable** (no app behavior).
11. [Release automation](feature-points/11-release-automation.md) — GitHub Actions npm publish + zip release on tag push. **Untested** (real release action).
12. [Automated test suite](feature-points/12-test-suite.md) — covers items 1–4, 6, and 13–15.
13. [Oracle MCP server](feature-points/13-oracle-mcp-server.md) — passthrough `oracle_query` tool, per-request connection, no-op audit hook. **Tested.**
14. [Loki MCP server](feature-points/14-loki-mcp-server.md) — read-only `loki_query_range`/`loki_labels`/`loki_label_values` tools. **Tested.**
15. [opencode memory MCP](feature-points/15-opencode-memory-mcp.md) — wires in the official `@modelcontextprotocol/server-memory` package (config + prompt policy only, no server code of our own). **Tested.**
16. [java-lsp MCP server](feature-points/16-java-lsp-mcp-server.md) — jdtls-backed Java code-intelligence tools. **Tested** (real jdtls, manual — not yet in `./tests/run-all.sh`).
17. [spring-lsp MCP server](feature-points/17-spring-lsp-mcp-server.md) — spring-boot-language-server-backed Spring-aware tools. **Protocol-tested only** — Spring-specific semantic richness not verified, see its feature-point doc.
