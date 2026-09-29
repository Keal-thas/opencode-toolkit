import { appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import type { Plugin, ToolContext, ToolResult } from "@opencode-ai/plugin";

// permission.ask exists in the plugin types but is never dispatched by
// opencode's runtime (verified against dev-branch source) - so tool.execute.before
// is the real interception point instead: it fires before the tool's own
// permission check, and throwing blocks the call outright (same mechanism the
// official .env-protection example uses). This layers under the config:
//   - allow -> review runs first; only a clean verdict lets it through.
//   - ask   -> review runs before the human is prompted; block short-circuits it.
//   - deny  -> review still runs and logs, but can only ADD a block, never
//     remove the config's own deny.

// Tool names that get an LLM safety review before they're allowed to run.
// Extend this to gate more tools (e.g. "edit", "webfetch").
const GATED_TOOLS = new Set(["bash"]);

// If the review call fails (server down, network error, timeout) or the
// model's reply can't be parsed as ALLOW/BLOCK: false blocks the command,
// since this plugin's whole job is to be a safety net and "couldn't get an
// opinion" isn't a clean bill of health. The cost: on this repo's
// self-hosted-model deployment (see docs/deployment-environment.md), a
// hiccup on that model server blocks every bash call on the machine until
// it recovers - including the ones that would help debug why review is
// down. Flip to true to trade that safety margin away for availability.
const FAIL_OPEN_ON_ERROR = false;

const REVIEW_TIMEOUT_MS = 30_000;

const outDir = join(homedir(), "opencode-hook-output");

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function logReview(entry: Record<string, unknown>) {
  const file = join(outDir, "llm-review.jsonl");
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
  try {
    if (!existsSync(outDir)) await mkdir(outDir, { recursive: true });
    await appendFile(file, line);
  } catch (e) {
    // logging must never be the reason the gate itself breaks
  }
}

// Custom tool the review-gate agent uses to record its verdict as a real
// function call (confirmed enabled on this deployment's model - see
// deploy/opencode.json.example's "review_verdict" permission, denied globally
// and re-allowed only for "review-gate"). Keyed by session ID so concurrent
// reviews never clobber each other.
//
// Built as a plain object rather than @opencode-ai/plugin's `tool()` helper
// (the documented alternative - see custom-tools.mdx's "Arguments" section):
// every other plugin here only imports @opencode-ai/plugin's types (erased at
// build time), and `tool()` is a real runtime value that would make this the
// one plugin actually needing the package installed. `zod` alone (already
// needed for the schema) avoids that.
const VERDICT_TOOL_NAME = "review_verdict";
// Cleaned up by tool.execute.before's own finally, not review()'s - see the
// comment there for why: a verdict recorded just before a timeout/late error
// must still be readable after review() itself has already thrown.
const pendingVerdicts = new Map<string, { allow: boolean; reason?: string }>();

const reviewVerdictArgs = {
  allow: z.boolean().describe("true to allow the command to run, false to block it"),
  reason: z.string().optional().describe("required when allow is false: one short sentence explaining why"),
};

const reviewVerdictTool = {
  description: "Record the ALLOW/BLOCK verdict for the command under review. Call this exactly once - it is the only tool available here.",
  args: reviewVerdictArgs,
  async execute(args: z.infer<z.ZodObject<typeof reviewVerdictArgs>>, context: ToolContext): Promise<ToolResult> {
    pendingVerdicts.set(context.sessionID, args);
    return args.allow ? "ALLOW recorded" : `BLOCK recorded: ${args.reason ?? "no reason given"}`;
  },
};

const REVIEW_SYSTEM_PROMPT = `You are a security gate reviewing a single shell command before it is allowed to run on the user's machine. You are NOT the assistant helping the user - you only judge this one command in isolation, with no other context.

Block a command only if it is clearly destructive, irreversible, or likely to cause real harm without the user's informed consent: e.g. deleting or overwriting files/data outside an obvious scratch/temp area, force-pushing or rewriting git history, modifying system or security settings, exfiltrating secrets or credentials, downloading and running untrusted code, or anything clearly malicious.

Do not block ordinary development work: reading files, listing directories, running builds/tests, git commits, installing declared dependencies, editing project files, etc. When in doubt, ALLOW - you are a safety net for genuinely dangerous commands, not a style reviewer.

You MUST record your verdict by calling the "${VERDICT_TOOL_NAME}" tool exactly once - it is the only tool you have. Only if that tool is somehow unavailable, reply with plain text instead, in exactly this format and nothing else:
ALLOW
or
BLOCK: <one short sentence explaining why>`;

export const LlmReviewGate: Plugin = async ({ client }) => {
  // A session is opencode's only unit of model invocation, and it's stateful:
  // every prompt() call appends to that session's history, replayed as context
  // on the next call. A single long-lived review session (the earlier design)
  // would grow that history every gated call, inflating cost and contradicting
  // REVIEW_SYSTEM_PROMPT's "judge this command in isolation" framing. So:
  // one throwaway session per review, deleted right after - create/delete are
  // cheap metadata calls, not model calls, so no second LLM round trip.
  const reviewSessionIDs = new Set<string>();

  async function review(command: string, onSessionCreated?: (sessionID: string) => void) {
    const created = await client.session.create({
      body: { title: "llm-review-gate (internal, safe to delete)" },
      throwOnError: true,
    });
    const sessionID = created.data.id;
    onSessionCreated?.(sessionID); // lets the caller check pendingVerdicts for this session if this call ends up racing a timeout
    reviewSessionIDs.add(sessionID); // never review this session's own tool calls (no self-recursion)
    try {
      const res = await client.session.prompt({
        path: { id: sessionID },
        body: {
          // Verified against opencode dev-branch source (session/llm/request.ts):
          // `system` is appended after an agent's configured `prompt`, not a
          // replacement. Without an explicit `agent` here, this session would
          // inherit the default primary agent and run system-prompt.txt's full
          // persona ahead of REVIEW_SYSTEM_PROMPT, competing for attention.
          // "review-gate" has no `prompt` override and denies every tool except
          // `review_verdict`, so calling that tool is the model's only option.
          agent: "review-gate",
          system: REVIEW_SYSTEM_PROMPT,
          parts: [{ type: "text", text: `Command:\n${command}` }],
        },
        throwOnError: true,
      });

      // Prefer the tool call - it's a real structured verdict instead of a
      // regex guess against free text. Only fall back to text parsing if
      // the model didn't call the tool (ignored the instruction, or this
      // deployment's tool-call parser doesn't cooperate for some reason).
      const verdictArgs = pendingVerdicts.get(sessionID);
      if (verdictArgs) {
        return verdictArgs.allow
          ? { verdict: "allow" as const, raw: `[tool call] allow=true` }
          : { verdict: "block" as const, reason: verdictArgs.reason || "blocked by LLM review", raw: `[tool call] allow=false reason=${verdictArgs.reason ?? ""}` };
      }

      const text = (res.data.parts ?? [])
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n")
        .trim();
      const firstLine = text.split("\n")[0]?.trim() ?? "";
      if (/^ALLOW/i.test(firstLine)) return { verdict: "allow" as const, raw: text };
      if (/^BLOCK/i.test(firstLine)) {
        const reason = firstLine.replace(/^BLOCK:?\s*/i, "") || "blocked by LLM review";
        return { verdict: "block" as const, reason, raw: text };
      }
      return { verdict: "unclear" as const, raw: text };
    } finally {
      reviewSessionIDs.delete(sessionID);
      await client.session.delete({ path: { id: sessionID } }).catch(() => {
        // best-effort cleanup; a leaked internal session is harmless clutter, not a correctness problem
      });
    }
  }

  return {
    tool: {
      [VERDICT_TOOL_NAME]: reviewVerdictTool,
    },
    "tool.execute.before": async (input, output) => {
      if (!GATED_TOOLS.has(input.tool)) return;
      if (reviewSessionIDs.has(input.sessionID)) return; // never review the review session's own calls

      const command = input.tool === "bash" ? output.args?.command : JSON.stringify(output.args);
      let reviewSessionID: string | undefined;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

      try {
        let result;
        try {
          result = await Promise.race([
            review(command, (id) => { reviewSessionID = id; }),
            new Promise<never>((_, reject) => {
              timeoutHandle = setTimeout(() => reject(new Error("review timed out")), REVIEW_TIMEOUT_MS);
            }),
          ]);
        } catch (e) {
          // The model may have already called review_verdict - recording a
          // real verdict in pendingVerdicts - before this race was lost to a
          // timeout, or before a late error (e.g. a dropped connection right
          // after the tool call). Either way that's a real answer, not a
          // "couldn't get an opinion" situation, so it must win over the
          // FAIL_OPEN_ON_ERROR default below.
          const lateVerdict = reviewSessionID ? pendingVerdicts.get(reviewSessionID) : undefined;
          if (lateVerdict) {
            await logReview({
              tool: input.tool,
              sessionID: input.sessionID,
              callID: input.callID,
              command,
              verdict: lateVerdict.allow ? "allow" : "block",
              raw: `[late verdict after "${errorMessage(e)}"] allow=${lateVerdict.allow} reason=${lateVerdict.reason ?? ""}`,
            });
            if (!lateVerdict.allow) {
              throw new Error(`Blocked by LLM review: ${lateVerdict.reason || "blocked by LLM review"}`);
            }
            return;
          }

          const decision = FAIL_OPEN_ON_ERROR ? "allow (fail-open)" : "block (fail-closed)";
          await logReview({
            tool: input.tool,
            sessionID: input.sessionID,
            callID: input.callID,
            command,
            error: errorMessage(e),
            decision,
          });
          if (FAIL_OPEN_ON_ERROR) return;
          throw new Error(`llm-review-gate: review unavailable, blocking (fail-closed): ${errorMessage(e)}`);
        }

        await logReview({
          tool: input.tool,
          sessionID: input.sessionID,
          callID: input.callID,
          command,
          verdict: result.verdict,
          raw: result.raw,
        });

        if (result.verdict === "block") {
          throw new Error(`Blocked by LLM review: ${result.reason}`);
        }
        if (result.verdict === "unclear" && !FAIL_OPEN_ON_ERROR) {
          throw new Error(`llm-review-gate: could not parse review verdict, blocking (fail-closed). Raw: ${result.raw.slice(0, 200)}`);
        }
        // "allow", or "unclear" while fail-open: fall through to whatever
        // the config's own allow/ask/deny tier would normally do.
      } finally {
        // Promise.race doesn't cancel its losing side - without this, a
        // review that resolves quickly still leaves this timer running for
        // the full REVIEW_TIMEOUT_MS, uselessly rejecting an already-settled
        // promise once it fires (harmless, but it's a real dangling timer:
        // reproduced by it keeping this plugin's test process alive for a
        // full 30s per test despite every individual test finishing in
        // milliseconds).
        if (timeoutHandle) clearTimeout(timeoutHandle);
        // The only place pendingVerdicts is cleaned up - see the comment on
        // its declaration for why review() itself no longer does this.
        if (reviewSessionID) pendingVerdicts.delete(reviewSessionID);
      }
    },
  };
};
