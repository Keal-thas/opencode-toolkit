#!/usr/bin/env node
// Minimal stdio MCP server for compaction.probe.mjs: one tool, `big`, that returns `kb` KiB of numbered text lines. Raw JSON-RPC, no SDK dependency, so the probe needs nothing beyond what harness.mjs already pulls in.
import { createInterface } from "node:readline";

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (req.id === undefined) return; // notification
  switch (req.method) {
    case "initialize":
      send({ id: req.id, result: { protocolVersion: req.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "big-output", version: "1.0.0" } } });
      break;
    case "tools/list":
      send({
        id: req.id,
        result: {
          tools: [
            {
              name: "big",
              description: "Returns a large block of numbered text lines.",
              inputSchema: { type: "object", properties: { kb: { type: "number" } }, required: ["kb"] },
            },
          ],
        },
      });
      break;
    case "tools/call": {
      const target = (req.params.arguments?.kb ?? 1) * 1024;
      let text = "";
      for (let i = 1; text.length < target; i++) text += `mcp line ${i} ${"y".repeat(40)}\n`;
      send({ id: req.id, result: { content: [{ type: "text", text }] } });
      break;
    }
    default:
      send({ id: req.id, error: { code: -32601, message: `unsupported: ${req.method}` } });
  }
});
