import type { Plugin } from "@opencode-ai/plugin";

// /verify <claim> starts a separate top-level session (not a subtask, so it
// keeps the normal agent's full permissions) that reviews the current changes
// with a fresh context. The new session is seeded with only what an outside
// reviewer could observe: the claim, the user's own requests from the calling
// session (the spec), and git evidence. The calling session's assistant
// messages and reasoning are deliberately left out, so the reviewer can't
// inherit the implementer's blind spots.

const COMMAND_NAME = "verify";
// Char budget for the user's requests as a whole, not a message count: the opening messages usually define the task and the latest ones are often just "continue".
const MAX_REQUESTS_CHARS = 16_000;
const MAX_MESSAGE_CHARS = 3000;
const KEEP_FIRST = 2;
const MAX_DIFF_CHARS = 60_000;
const MAX_REPORT_CHARS = 6000;

const REVIEW_INSTRUCTIONS = `You are an independent verifier. You did not write this change and have no memory of how it was made. Trust only what you can observe yourself: the diff, the files, and the output of commands you run.

- The user does not trust the agent's completion report and is asking you to check it. Treat every statement in it as a hypothesis to falsify: "done", "tests pass", "fixed" mean nothing until you have observed them yourself.
- Compare three things: what the user asked for, what the report claims, and what the code actually does. Look for requirements the report silently skipped, results it overstated, and changes it did not mention.
- Check each requirement separately against the code, reading the surrounding code and not just the diff hunk.
- Run the project's tests, or the narrowest command that exercises the change, and report the real output.
- Do not modify files; describe fixes instead.

Finish with:
VERDICT: PASS | FAIL | UNVERIFIABLE
- one line per requirement: met / not met / not checked, with file:line or command evidence
- problems found, most severe first
- anything you could not check, and why`;

const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}\n...[truncated ${s.length - max} chars]` : s);

export const VerifySession: Plugin = async ({ client, serverUrl, $ }) => {
  async function git(args: string[]): Promise<string> {
    try {
      return (await $`git ${args}`.quiet().nothrow().text()).trim();
    } catch {
      return "";
    }
  }

  const textOf = (parts: { type: string; synthetic?: boolean }[]) =>
    parts.filter((p) => p.type === "text" && !p.synthetic).map((p) => (p as unknown as { text: string }).text).join("\n").trim();

  // The user's own messages are the spec. From the assistant we take only its last
  // text message - its completion report, which is the thing under suspicion - and
  // never its tool calls or reasoning.
  async function readSession(sessionID: string): Promise<{ requests: string[]; report: string }> {
    try {
      const res = await client.session.messages({ path: { id: sessionID }, throwOnError: true });
      const msgs = res.data ?? [];
      const requests = msgs.filter((m) => m.info.role === "user").map((m) => textOf(m.parts)).filter(Boolean).map((t) => truncate(t, MAX_MESSAGE_CHARS));
      const report = msgs.filter((m) => m.info.role === "assistant").map((m) => textOf(m.parts)).filter(Boolean).at(-1) ?? "";
      return { requests, report: truncate(report, MAX_REPORT_CHARS) };
    } catch {
      return { requests: [], report: "" };
    }
  }

  // Diff against the fork point from the main branch, so work the agent already committed is visible too (a plain `git diff HEAD` is empty then).
  async function baseRef(): Promise<string | undefined> {
    for (const b of ["origin/master", "origin/main", "master", "main"]) {
      const mb = await git(["merge-base", "HEAD", b]);
      if (mb) return mb;
    }
  }

  // Keep everything if it fits; otherwise keep the first KEEP_FIRST plus as many of the newest as fit, marking the gap.
  function fitRequests(all: string[]): string[] {
    const total = all.reduce((n, t) => n + t.length, 0);
    if (total <= MAX_REQUESTS_CHARS) return all;
    const head = all.slice(0, KEEP_FIRST);
    let budget = MAX_REQUESTS_CHARS - head.reduce((n, t) => n + t.length, 0);
    const tail: string[] = [];
    for (let i = all.length - 1; i >= KEEP_FIRST && budget > 0; i--) {
      if (all[i].length > budget) break;
      tail.unshift(all[i]);
      budget -= all[i].length;
    }
    const omitted = all.length - head.length - tail.length;
    return [...head, `[... ${omitted} earlier messages omitted ...]`, ...tail];
  }

  async function buildPrompt(claim: string, sourceSessionID: string): Promise<string> {
    const base = await baseRef();
    const [status, diff, log, session] = await Promise.all([
      git(["status", "--short"]),
      git(base ? ["diff", base] : ["diff", "HEAD"]),
      git(base ? ["log", "--oneline", `${base}..HEAD`] : ["log", "--oneline", "-10"]),
      readSession(sourceSessionID),
    ]);
    const requests = fitRequests(session.requests);
    return [
      `## What the user asked for in the originating session\n${requests.length ? requests.map((r, i) => `${i + 1}. ${r}`).join("\n") : "(unavailable)"}`,
      `## The agent's completion report - UNVERIFIED, the user doubts it\n${session.report || "(unavailable)"}`,
      claim ? `## What the user wants checked specifically\n${claim}` : "",
      `## git status --short\n${status || "(clean)"}`,
      `## git diff ${base ? "<fork point from main branch>" : "HEAD"} (tracked files only, committed + uncommitted - untracked files appear in status above, read them yourself)\n${truncate(diff, MAX_DIFF_CHARS) || "(empty)"}`,
      `## Commits on this branch\n${log || "(none)"}`,
    ].filter(Boolean).join("\n\n");
  }

  async function selectSession(sessionID: string) {
    // The v1 client the plugin receives has no tui.selectSession, so call the endpoint directly.
    await fetch(new URL("/tui/select-session", serverUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionID }),
    });
  }

  return {
    config: async (config) => {
      config.command ??= {};
      config.command[COMMAND_NAME] ??= {
        description: "Review the current changes in a brand-new session (usage: /verify [what to check in particular])",
        template: "Reply with exactly: verify-session handled this command.",
      };
    },
    "command.execute.before": async (input, output) => {
      if (input.command !== COMMAND_NAME) return;
      try {
        const prompt = await buildPrompt(input.arguments.trim(), input.sessionID);
        const created = await client.session.create({ body: { title: `verify: ${input.arguments.trim().slice(0, 60) || "current changes"}` }, throwOnError: true });
        const sessionID = created.data.id;
        // Fire and forget: the review runs for minutes, and the user should see it stream live in the new session.
        void client.session.promptAsync({ path: { id: sessionID }, body: { system: REVIEW_INSTRUCTIONS, parts: [{ type: "text", text: prompt }] } }).catch(() => {});
        await selectSession(sessionID).catch(() => {});
        output.parts = [{ type: "text", text: `A new review session (${sessionID}) was started. Reply with exactly: verify started.` } as (typeof output.parts)[number]];
      } catch (e) {
        output.parts = [{ type: "text", text: `/verify failed to start a review session: ${e instanceof Error ? e.message : String(e)}. Tell the user.` } as (typeof output.parts)[number]];
      }
    },
  };
};
