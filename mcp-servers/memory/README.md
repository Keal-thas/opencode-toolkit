# memory

Cross-session memory for opencode, via Anthropic's official `@modelcontextprotocol/server-memory` package used unmodified — no server code of our own here. It is a local knowledge graph (entities, relations, observations) persisted as a JSONL file and searched by keyword, not embeddings.

opencode has no cross-session memory of its own: `AGENTS.md`/`instructions` are static and re-injected every session, and skills are pre-written instructions, not accumulated knowledge (see `docs/opencode-docs-reference/rules.mdx`, `skills.mdx`).

## Wiring

- `deploy/opencode.json.example`'s `mcp.memory` entry, `type: "local"`: opencode spawns `mcp-server-memory` itself, installed once with `npm install -g @modelcontextprotocol/server-memory` (SETUP.md step 11). Unlike oracle/loki it needs no separately-supervised process.
- `deploy/system-prompt.txt`'s `# Memory` section tells the model when to read and write. Without it the tools exist but nothing prompts the model to use them.
- `MEMORY_FILE_PATH` points at `$CONFIG_DIR/memory.jsonl`.

## Why this and not RAG

This covers small structured memory (preferences, project facts, decisions). Searching a large document corpus by meaning is a different problem needing an embedding model and a vector store, neither verified as feasible on the offline target; it is not addressed here (see `TODO.md`). Keyword-only memory needs no embedding dependency and stays on Node/npm like the rest of the MCP tooling.

## Limits

- No forced retrieval at session start: the model has to decide to call `search_nodes`/`read_graph` from the prompt instruction. A plugin `session.created` hook that injects the graph would be stronger if the prompt-only version proves unreliable.
- No review or consolidation pass over what gets written.
- `memory.jsonl` is local machine state, not backed up or versioned by this repo.

## Tests

`tests/integration/mcp-memory/memory.test.mjs` spawns the real package over stdio like opencode does and drives it with a real MCP client: tool listing, a `create_entities`/`search_nodes` round trip, and `MEMORY_FILE_PATH` being written. It verifies the upstream package, not the target machine (global install on `PATH`, the real model's tool-calling) — both flagged in SETUP.md's "Report back".
