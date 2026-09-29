// Loaded as a global opencode plugin (fake HOME's .config/opencode/plugins/,
// see lib/harness.mjs) - logs every hook it gets a real runtime invocation
// for, one JSONL file per hook name under PROBE_LOG_DIR. Controlled entirely
// through env vars so every script in this directory can reuse the same file:
//   PROBE_BLOCK_TOOL    - if set, throw in tool.execute.before for this exact
//                          tool name, to check whether the throw really blocks
//                          execution end-to-end (not just that it throws).
//   PROBE_SYSTEM_MARKER - if set, append this string to the system prompt via
//                          experimental.chat.system.transform, to check
//                          whether that hook's output actually reaches the
//                          model (cross-checked against the captured raw
//                          request body, not just that the hook fired).
import { appendFileSync, mkdirSync } from "node:fs";

const LOG_DIR = process.env.PROBE_LOG_DIR;
mkdirSync(LOG_DIR, { recursive: true });

function log(name, payload) {
  appendFileSync(`${LOG_DIR}/${name}.jsonl`, JSON.stringify({ ts: new Date().toISOString(), ...payload }) + "\n");
}

export const ProbeHook = async () => {
  return {
    event: async ({ event }) => log("event", { event }),
    "chat.message": async (input, output) => log("chat.message", { input, output }),
    "chat.params": async (input, output) => log("chat.params", { input, output }),
    "chat.headers": async (input, output) => log("chat.headers", { input, output }),
    "permission.ask": async (input, output) => log("permission.ask", { input, output }),
    "command.execute.before": async (input, output) => log("command.execute.before", { input, output }),
    "tool.definition": async (input, output) => log("tool.definition", { input, output }),
    "tool.execute.before": async (input, output) => {
      log("tool.execute.before", { input, output });
      if (process.env.PROBE_BLOCK_TOOL && input.tool === process.env.PROBE_BLOCK_TOOL) {
        throw new Error(`blocked-by-probe: intentionally blocked ${input.tool} to verify tool.execute.before actually prevents execution`);
      }
    },
    "tool.execute.after": async (input, output) => log("tool.execute.after", { input, output }),
    "experimental.chat.system.transform": async (input, output) => {
      if (process.env.PROBE_SYSTEM_MARKER) {
        output.system.push(process.env.PROBE_SYSTEM_MARKER);
      }
      // Logged after the push (not before) so the log itself shows whether
      // the mutation took effect on this same object, independent of
      // whether that object is what actually gets serialized downstream.
      log("experimental.chat.system.transform", { input, output });
    },
  };
};
