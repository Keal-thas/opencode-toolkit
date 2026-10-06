import type { Plugin } from "@opencode-ai/plugin";

// A small model's commonest failure is calling the same tool with the same
// arguments over and over. This counts consecutive identical calls per session
// and, once the result is also unchanged, tells the model to stop; for the
// read-only search tools it eventually refuses the call.

// Consecutive identical calls (same tool, same arguments) after which the
// tool output gets a notice appended. Only counted while the output is
// unchanged: a call that returns something new is progress and restarts the run.
const WARN_AT = 3;
// Identical calls after which the next identical call to a BLOCKABLE tool is refused.
const BLOCK_AT = 5;
// Only tools with no side effects are ever refused; repeating `bash` or `edit` may be deliberate.
const BLOCKABLE = new Set(["read", "grep", "glob"]);
// `task` starts subagents, whose own sessions have their own loop state.
const EXEMPT = new Set(["task"]);
const MAX_SESSIONS = 256;
const MARKER = "[REPEATED TOOL CALL - STOP]";

const WARNING = `\n\n${MARKER}\nYou have made the exact same call with identical arguments ${WARN_AT} times in a row and got the same result each time, so you are making no progress. Do not repeat it. Either make a different call (another path, pattern or tool), or, if the task is done, give your final answer now.`;

// Key order must not matter: {a, b} and {b, a} are the same call.
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const rec = value as Record<string, unknown>;
  return `{${Object.keys(rec).sort().map((k) => `${JSON.stringify(k)}:${stable(rec[k])}`).join(",")}}`;
}

type Run = {
  key: string;
  // Calls in the current run, counting the one in flight.
  runs: number;
  // Output of the most recent completed call of this run; undefined until one completes (a failing tool never reaches tool.execute.after).
  output?: string;
};

export const LoopGuard: Plugin = async () => {
  const sessions = new Map<string, Run>();

  const remember = (sessionID: string, run: Run) => {
    sessions.delete(sessionID); // re-insert so the oldest session is evicted first
    sessions.set(sessionID, run);
    if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value as string);
  };

  return {
    // A new user message is a new turn; repeating a call after the user spoke is not a loop.
    "chat.message": async (input) => {
      sessions.delete(input.sessionID);
    },
    "tool.execute.before": async (input, output) => {
      if (EXEMPT.has(input.tool)) return;
      const key = `${input.tool}:${stable(output.args)}`;
      const last = sessions.get(input.sessionID);
      if (!last || last.key !== key) {
        remember(input.sessionID, { key, runs: 1 });
        return;
      }
      // Failing calls never reach the after hook, so they can only be counted here: a read of a file that does not exist repeated forever is still a loop.
      if (last.runs >= BLOCK_AT && BLOCKABLE.has(input.tool)) {
        throw new Error(
          `Refusing to run "${input.tool}": this exact call has been made ${last.runs} times in a row without a different result, which is a loop. Stop repeating it: make a different call, or give your final answer.`,
        );
      }
      last.runs += 1;
    },
    "tool.execute.after": async (input, output) => {
      if (EXEMPT.has(input.tool) || typeof output.output !== "string") return;
      const run = sessions.get(input.sessionID);
      // The session moved on (or was reset) while this call ran: nothing to compare against.
      if (!run || run.key !== `${input.tool}:${stable(input.args)}`) return;
      // Compare and remember the raw output, never the one with the notice appended, or the next identical result would look like a change.
      const raw = output.output;
      if (run.output !== undefined && run.output === raw) {
        if (run.runs >= WARN_AT && !raw.includes(MARKER)) output.output += WARNING;
      } else {
        run.runs = 1; // first result, or a different one: progress
      }
      run.output = raw;
    },
  };
};
