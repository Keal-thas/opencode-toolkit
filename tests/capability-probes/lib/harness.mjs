// Shared scaffolding for every script in tests/capability-probes/ - not a test
// framework, just the boilerplate every probe needs (a real opencode server, a
// fake OpenAI-compatible model endpoint, a fake HOME with a real plugin loaded
// from a real plugin directory). See tests/README.md's "Capability probes vs.
// tests" section for what this directory is and isn't.
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createOpencode } from "@opencode-ai/sdk";

// A "plan" is an array of round definitions, one per chat-completion request
// the fake provider expects to receive for the case currently under test:
//   { toolCall: { id, name, args } } -> stream a tool_calls delta requesting
//     that tool, so the real opencode server actually invokes it for real.
//   { text: "..." }                  -> stream plain text, ending the turn.
// Once the plan runs out, later requests (e.g. the continuation after a tool
// result) get a generic closing text so the turn always terminates instead of
// hanging.
export function startFakeProvider() {
  const capturedRequests = [];
  let plan = [];
  let roundIndex = 0;

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      capturedRequests.push(parsed);
      const round = plan[roundIndex] ?? { text: "probe fallback: plan exhausted" };
      roundIndex++;

      res.writeHead(200, { "content-type": "text/event-stream" });
      const now = Math.floor(Date.now() / 1000);
      const send = (delta, finish) =>
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-fake",
            object: "chat.completion.chunk",
            created: now,
            model: parsed.model,
            choices: [{ index: 0, delta, finish_reason: finish ?? null }],
          })}\n\n`,
        );

      if (round.toolCall) {
        const { id, name, args } = round.toolCall;
        send({ role: "assistant", content: null, tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] });
        send({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] });
        send({}, "tool_calls");
      } else {
        send({ role: "assistant", content: round.text });
        send({}, "stop");
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        port: server.address().port,
        capturedRequests,
        setPlan(newPlan) {
          plan = newPlan;
          roundIndex = 0;
        },
      }),
    );
  });
}

// pluginFiles: { "filename.js": "source code" } written into the fake HOME's
// global plugin directory (~/.config/opencode/plugins/) - loaded automatically
// by opencode's own directory scan, no config array entry needed.
// config: merged into the opencode Config passed straight through via
// createOpencode()'s OPENCODE_CONFIG_CONTENT mechanism (model/provider are
// pre-filled to point at the fake provider; pass e.g. `permission` to override
// per-probe).
export async function setupProbeEnv({ pluginFiles = {}, config = {} } = {}) {
  const workDir = await mkdtemp(join(tmpdir(), "capability-probe-"));
  const fakeHome = join(workDir, "home");
  const logDir = join(workDir, "hook-logs");
  await mkdir(join(fakeHome, ".config", "opencode", "plugins"), { recursive: true });
  await mkdir(logDir, { recursive: true });

  for (const [filename, content] of Object.entries(pluginFiles)) {
    await writeFile(join(fakeHome, ".config", "opencode", "plugins", filename), content);
  }

  const provider = await startFakeProvider();

  process.env.HOME = fakeHome;
  // os.homedir() reads USERPROFILE on Windows - without it the opencode server this starts uses the real home.
  process.env.USERPROFILE = fakeHome;
  process.env.PROBE_LOG_DIR = logDir;
  process.env.OPENCODE_DISABLE_MODELS_FETCH = "1";

  const { client, server: opencodeServer } = await createOpencode({
    config: {
      $schema: "https://opencode.ai/config.json",
      model: "faketest/fake-model",
      provider: {
        faketest: {
          npm: "@ai-sdk/openai-compatible",
          name: "Fake Test Provider",
          options: { baseURL: `http://127.0.0.1:${provider.port}/v1` },
          models: { "fake-model": { name: "Fake Model" } },
        },
      },
      ...config,
    },
  });

  async function firedHooks() {
    try {
      return (await readdir(logDir)).map((f) => f.replace(/\.jsonl$/, "")).sort();
    } catch {
      return [];
    }
  }

  async function readHookLog(name) {
    try {
      return (await readFile(join(logDir, `${name}.jsonl`), "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  // Full message history across the session, not just the last round -
  // session.prompt()'s own return value only reflects the message it most
  // recently created, so a tool call from an earlier round (e.g. before a
  // block, or before a multi-step continuation) is invisible without this.
  async function transcript(sessionID) {
    const res = await client.session.messages({ path: { id: sessionID } });
    return (res.data ?? []).flatMap((m) => m.parts ?? []);
  }

  async function cleanup() {
    opencodeServer.close();
    provider.server.close();
    // The server process exits asynchronously and, on Windows, still holds its SQLite files (EBUSY) - retry.
    await rm(workDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }

  return { client, provider, workDir, logDir, firedHooks, readHookLog, transcript, cleanup };
}

export async function saveEvidence(evidenceDir, files) {
  await mkdir(evidenceDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(evidenceDir, name), typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
}
