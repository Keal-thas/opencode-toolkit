import { appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import type { Plugin, ToolContext, ToolResult } from "@opencode-ai/plugin";

// permission.ask exists in @opencode-ai/plugin's type definitions but is
// never actually dispatched by opencode's runtime (verified against the
// real dev-branch source, not just the docs/types) - so it cannot be used
// to intercept allow/ask/deny decisions. tool.execute.before is the real,
// working interception point: it fires unconditionally before the tool's
// own permission check runs, and throwing inside it blocks the call
// outright (same mechanism the official .env-protection example plugin
// uses). That gives us the layering the user asked for:
//   - config says "allow" -> review still runs first; only a clean
//     "allow" verdict lets it fall through to the real auto-run.
//   - config says "ask"   -> review runs before the human is ever
//     prompted; a "block" verdict short-circuits before that prompt.
//   - config says "deny"  -> review still runs (and gets logged) even
//     though the config's own deny wins either way - we can only ever
//     ADD a block here, never remove one the config would apply later.

// Tool names that get an LLM safety review before they're allowed to run.
// Extend this to gate more tools (e.g. "edit", "webfetch").
const GATED_TOOLS = new Set(["bash"]);

// If the review call itself fails (model server down, network error,
// timeout) this decides what happens: true = let the command through
// (an availability failure isn't a security verdict, and fail-closed
// here would brick every bash call including the ones needed to debug
// why review is down). Flip to false for stricter fail-closed behavior.
const FAIL_OPEN_ON_ERROR = true;

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
// function call, verified enabled on this deployment's model (see
// deploy/opencode.json.example's "review_verdict" permission: denied
// globally, allowed only for the "review-gate" agent - a plugin-registered
// tool is otherwise available to every agent by name, same as a built-in
// one, per docs/opencode-docs-reference/custom-tools.mdx). Keyed by review
// session ID so concurrent reviews (multiple gated tool calls in flight at
// once, each with its own one-shot session) never clobber each other.
//
// Built as a plain object (the documented alternative to @opencode-ai/plugin's
// `tool()` helper - see docs/opencode-docs-reference/custom-tools.mdx's
// "Arguments" section) rather than calling `tool()` itself, because every
// other plugin in this repo only ever imports @opencode-ai/plugin's *types*
// (erased at build time, zero runtime footprint) - `tool()` is a real
// runtime value, and pulling it in would make this the one plugin that
// actually needs @opencode-ai/plugin installed to run. `zod` alone (already
// a real dependency below, needed for the args schema regardless) avoids that.
const VERDICT_TOOL_NAME = "review_verdict";
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
  // A session is opencode's only unit of model invocation (there's no
  // stateless "just complete this text" endpoint) - but it's also a
  // stateful conversation: every session.prompt() call appends to that
  // session's own message history, which then gets replayed as context on
  // every later call to the same session. A single long-lived review
  // session (the previous design) would grow that history by one
  // command+verdict turn per gated tool call for as long as the plugin
  // instance lives, quietly inflating token cost per review and eventually
  // contradicting REVIEW_SYSTEM_PROMPT's own "judge this one command in
  // isolation, with no other context" framing. So instead: one throwaway
  // session per review, deleted right after - session.create/delete are
  // cheap metadata calls, not model calls, so this doesn't add a second
  // LLM round trip, only a bit of bookkeeping.
  const reviewSessionIDs = new Set<string>();

  async function review(command: string) {
    const created = await client.session.create({
      body: { title: "llm-review-gate (internal, safe to delete)" },
      throwOnError: true,
    });
    const sessionID = created.data.id;
    reviewSessionIDs.add(sessionID); // never review this session's own tool calls (no self-recursion)
    try {
      const res = await client.session.prompt({
        path: { id: sessionID },
        body: {
          // Verified against opencode dev-branch source
          // (packages/opencode/src/session/llm/request.ts): the request's
          // `system` field does NOT replace an agent's configured `prompt` -
          // it's appended after it. Without an explicit `agent` here this
          // session would inherit whichever primary agent (build/plan/general)
          // is default, and in this deployment that means the full
          // system-prompt.txt persona ("you are opencode, a CLI coding
          // agent...") would run *ahead of* REVIEW_SYSTEM_PROMPT, competing
          // with the review instructions. "review-gate" (see
          // deploy/opencode.json.example) has no `prompt` override - so it
          // falls back to opencode's generic per-model default instead - and
          // denies every tool permission except `review_verdict`, so the
          // model's only real option is to call that tool rather than reach
          // for bash/edit/etc.
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
      pendingVerdicts.delete(sessionID);
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

      let result;
      try {
        result = await Promise.race([
          review(command),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("review timed out")), REVIEW_TIMEOUT_MS)),
        ]);
      } catch (e) {
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
    },
  };
};
