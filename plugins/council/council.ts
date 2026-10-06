import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Plugin, ToolContext, ToolResult } from "@opencode-ai/plugin";

// A `council` tool for decisions where one answer from one model is not enough.
// Each seat answers independently in its own child session with its own steering
// prompt; a synthesizer that has no tools then compares the answers. Prompts are
// awaited with session.prompt, never fired with promptAsync, so nothing here can
// race another hook into injecting a second prompt (docs/multi-agent-prior-art.md).

const SEAT_AGENT = "council-seat";
const SYNTH_AGENT = "council-synth";
const COMMAND = "council";

const DEFAULT_SEAT_TIMEOUT_S = 300;
const DEFAULT_SYNTH_TIMEOUT_S = 180;

const SEAT_RULES = `You are one of several independent advisors answering the same question; the others cannot see your answer. You may read files (read, glob, grep) but cannot change anything. Answer in at most 250 words: your position in the first sentence, then the reasons that decide it, then what would change your mind. Cite file:line for claims about code. If you cannot tell, say so instead of guessing.`;

const DEFAULT_SEATS: Seat[] = [
  { name: "skeptic", prompt: "Your angle: what is wrong, risky or unstated. Look for bugs, edge cases, failure modes and hidden assumptions in the proposal or in the premise of the question." },
  { name: "architect", prompt: "Your angle: structure and long-term cost. Look at boundaries, coupling, what is hard to change later, and whether a simpler design does the same job." },
  { name: "pragmatist", prompt: "Your angle: the smallest correct thing to do. Prefer mechanisms that already exist, and weigh each option by what it costs to build and to verify." },
];

const SYNTH_PROMPT = `You combine the answers of independent advisors to one question. You have no tools and cannot check anything: use only what the advisors wrote, and add no facts of your own.

Reply in exactly this form:
CONSENSUS: unanimous | majority | split
ANSWER: <the answer the advisors support. If they are split, state each position and which advisors hold it, and do not pick one unless the reasons given clearly decide it.>
DISAGREEMENTS: <one bullet per point where advisors differ, naming them, or "none">

Rate unanimous only if every advisor reaches the same recommendation, majority if more than half do, otherwise split. Never present a split as agreement.`;

type Seat = { name: string; prompt: string; model?: string };
type Config = { seats: Seat[]; synthModel?: string; seatTimeoutS: number; synthTimeoutS: number };

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Optional config, re-read on every call so an edit takes effect without a restart.
// Same location convention as the mcp-servers: config.json, or config-<name>.json when COUNCIL_CONFIG_ENV=<name>.
async function loadConfig(): Promise<Config> {
  const envName = process.env.COUNCIL_CONFIG_ENV;
  const file = join(homedir(), ".config", "kealthas-dev", "opencode-council", envName ? `config-${envName}.json` : "config.json");
  let raw: unknown = {};
  try {
    raw = JSON.parse(await readFile(file, "utf-8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`council: cannot read ${file}: ${errorMessage(e)}`);
  }
  const parsed = z
    .object({
      seats: z.array(z.object({ name: z.string().min(1), prompt: z.string().min(1), model: z.string().optional() })).min(2).optional(),
      synthesizer: z.object({ model: z.string().optional() }).optional(),
      seatTimeoutSeconds: z.number().positive().optional(),
      synthTimeoutSeconds: z.number().positive().optional(),
    })
    .safeParse(raw);
  if (!parsed.success) throw new Error(`council: invalid config ${file}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const c = parsed.data;
  return {
    seats: c.seats ?? DEFAULT_SEATS,
    synthModel: c.synthesizer?.model,
    seatTimeoutS: c.seatTimeoutSeconds ?? DEFAULT_SEAT_TIMEOUT_S,
    synthTimeoutS: c.synthTimeoutSeconds ?? DEFAULT_SYNTH_TIMEOUT_S,
  };
}

// "provider/model" -> the SDK's {providerID, modelID}; the model id itself may contain slashes.
function parseModel(spec: string | undefined) {
  if (!spec) return undefined;
  const i = spec.indexOf("/");
  if (i <= 0 || i === spec.length - 1) throw new Error(`council: model must look like "provider/model", got "${spec}"`);
  return { providerID: spec.slice(0, i), modelID: spec.slice(i + 1) };
}

// Last rule wins, so the catch-all deny comes first.
const SEAT_PERMISSION = { "*": "deny", read: "allow", glob: "allow", grep: "allow" };
const SYNTH_PERMISSION = { "*": "deny" };

const councilArgs = {
  question: z.string().describe("The decision or question to put to the council, stated so that it makes sense without the conversation"),
  context: z.string().optional().describe("What the advisors need to know: file paths to read, the options being weighed, constraints"),
};

export const Council: Plugin = async ({ client }) => {
  async function ask(opts: {
    agent: string;
    system: string;
    text: string;
    model?: string;
    timeoutS: number;
    directory: string;
    title: string;
    created: string[];
    signal: AbortSignal;
  }): Promise<string> {
    const session = await client.session.create({ body: { title: opts.title }, query: { directory: opts.directory }, throwOnError: true });
    const id = session.data.id;
    opts.created.push(id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const res = await Promise.race([
        client.session.prompt({
          path: { id },
          query: { directory: opts.directory },
          body: { agent: opts.agent, system: opts.system, model: parseModel(opts.model), parts: [{ type: "text", text: opts.text }] },
          throwOnError: true,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            void client.session.abort({ path: { id } }).catch(() => {});
            reject(new Error(`timed out after ${opts.timeoutS}s`));
          }, opts.timeoutS * 1000);
        }),
        // The caller cancelled (the user pressed escape): stop waiting at once; execute() aborts the child sessions.
        new Promise<never>((_, reject) => {
          if (opts.signal.aborted) reject(new Error("cancelled"));
          opts.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        }),
      ]);
      // The whole final message, not just its last text part: a model that writes its answer and then a closing line must not lose the answer.
      const text = (res.data.parts ?? [])
        .filter((p) => p.type === "text")
        .map((p) => (p as unknown as { text: string }).text)
        .join("\n")
        .trim();
      if (!text) throw new Error("empty answer");
      return text;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function execute(args: z.infer<z.ZodObject<typeof councilArgs>>, context: ToolContext): Promise<ToolResult> {
    const cfg = await loadConfig();
    const created: string[] = [];
    const stop = () => created.forEach((id) => void client.session.abort({ path: { id } }).catch(() => {}));
    context.abort.addEventListener("abort", stop);
    const question = args.context ? `${args.question}\n\n## Context\n${args.context}` : args.question;
    try {
      context.metadata({ title: `council: ${cfg.seats.length} seats` });
      const answers = await Promise.all(
        cfg.seats.map(async (seat) => {
          try {
            const text = await ask({
              agent: SEAT_AGENT,
              system: `${SEAT_RULES}\n\n${seat.prompt}`,
              text: question,
              model: seat.model,
              timeoutS: cfg.seatTimeoutS,
              directory: context.directory,
              title: `council seat ${seat.name} (internal, safe to delete)`,
              created,
              signal: context.abort,
            });
            return { seat, text };
          } catch (e) {
            return { seat, error: errorMessage(e) };
          }
        }),
      );
      if (context.abort.aborted) throw new Error("council: cancelled");

      const ok = answers.filter((a): a is { seat: Seat; text: string } => "text" in a);
      const verbatim = answers
        .map((a) => ("text" in a ? `### ${a.seat.name}\n${a.text}` : `### ${a.seat.name}\n(no answer: ${a.error})`))
        .join("\n\n");
      if (ok.length === 0) throw new Error(`council: no seat answered.\n\n${verbatim}`);
      const header = `# Council report (${ok.length} of ${answers.length} seats answered)`;
      if (ok.length === 1) {
        return `${header}\n\nOnly one seat answered, so there is no consensus to rate; read its answer as one opinion.\n\n## Seat answers (verbatim)\n${verbatim}`;
      }

      let synthesis: string;
      try {
        synthesis = await ask({
          agent: SYNTH_AGENT,
          system: SYNTH_PROMPT,
          text: `## Question\n${question}\n\n## Advisor answers\n${ok.map((a) => `### ${a.seat.name}\n${a.text}`).join("\n\n")}`,
          model: cfg.synthModel,
          timeoutS: cfg.synthTimeoutS,
          directory: context.directory,
          title: "council synthesis (internal, safe to delete)",
          created,
          signal: context.abort,
        });
      } catch (e) {
        // The seat answers are the valuable part; never lose them because the summary failed.
        return `${header}\n\nThe synthesis failed (${errorMessage(e)}), so there is no consensus rating; compare the answers yourself.\n\n## Seat answers (verbatim)\n${verbatim}`;
      }
      return `${header}\n\n${synthesis}\n\n## Seat answers (verbatim)\n${verbatim}`;
    } finally {
      context.abort.removeEventListener("abort", stop);
      await Promise.all(created.map((id) => client.session.delete({ path: { id } }).catch(() => {})));
    }
  }

  return {
    tool: {
      [COMMAND]: {
        description:
          "Put a question to several independent advisors and get their answers compared. Use it for a decision where being wrong is costly or the answer is genuinely contested, or when the user asks for a second opinion or several views. Costs several model calls, so do not use it for routine questions. Returns a consensus rating (unanimous, majority or split), the combined answer, the disagreements and every advisor's own answer.",
        args: councilArgs,
        execute,
      },
    },
    config: async (config) => {
      config.agent ??= {};
      config.agent[SEAT_AGENT] ??= {
        description: "Read-only advisor used by the council tool. Not user-facing.",
        mode: "subagent",
        hidden: true,
        permission: SEAT_PERMISSION as never,
      };
      config.agent[SYNTH_AGENT] ??= {
        description: "Tool-less synthesizer used by the council tool. Not user-facing.",
        mode: "subagent",
        hidden: true,
        permission: SYNTH_PERMISSION as never,
      };
      config.command ??= {};
      config.command[COMMAND] ??= {
        description: "Ask several independent advisors and compare their answers (usage: /council <question>)",
        template: `Call the ${COMMAND} tool with the question below as its question, and put anything the advisors need in context (file paths to read, the options being weighed). Then report the council's consensus rating and answer, any disagreements, and each advisor's own answer.\n\n$ARGUMENTS`,
      };
    },
  };
};
