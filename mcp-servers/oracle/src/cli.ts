#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { loadServerConfig } from "./paths.js";
import type { QueryResult } from "./types/config.js";

// Exit codes: 0 ok, 1 the SQL failed, 2 usage error, 3 the query could not run
// at all (server unreachable, bad credentials or config, blocked, timed out).
const EXIT_SQL = 1;
const EXIT_USAGE = 2;
const EXIT_UNAVAILABLE = 3;

const DEFAULT_LIMIT = 100;

const HELP = `Usage: oracle q "<sql>" [options]

Runs one read-only SQL statement through the local oracle query server and prints the rows to stdout.

Options:
  --limit N        most rows to print (default ${DEFAULT_LIMIT}; the server has its own hard cap)
  --all            print every row up to the server's cap
  --format F       csv (default), tsv or json (one JSON object per row)
  --json           same as --format json
  --schema NAME    run against this schema (ALTER SESSION SET CURRENT_SCHEMA)
  --out FILE       write the rows to FILE instead of stdout (implies --all unless --limit is given)
  --help           this text

When more rows exist than were printed, a notice goes to stderr. Cut the output with a WHERE clause or an aggregate,
or write it to a file with --out and look at it there.

Exit codes: 0 ok, 1 SQL error, 2 usage error, 3 could not run (server unreachable, bad credentials, blocked, timeout).`;

function usageError(message: string): never {
  console.error(`oracle: ${message}\n\n${HELP}`);
  process.exit(EXIT_USAGE);
}

interface Options {
  sql: string;
  limit: number | undefined;
  all: boolean;
  format: "csv" | "tsv" | "json";
  schema: string | undefined;
  out: string | undefined;
}

function parseArgs(argv: string[]): Options {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    process.exit(argv.length === 0 ? EXIT_USAGE : 0);
  }
  const [command, ...rest] = argv;
  if (command !== "q") usageError(`unknown command "${command}" (the only command is q)`);

  const opts: Options = { sql: "", limit: undefined, all: false, format: "csv", schema: undefined, out: undefined };
  const positional: string[] = [];
  const valueOf = (i: number, flag: string): string => {
    const v = rest[i + 1];
    if (v === undefined) usageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--all") opts.all = true;
    else if (arg === "--json") opts.format = "json";
    else if (arg === "--limit") {
      const n = Number(valueOf(i++, arg));
      if (!Number.isInteger(n) || n <= 0) usageError("--limit must be a positive integer");
      opts.limit = n;
    } else if (arg === "--format") {
      const f = valueOf(i++, arg);
      if (f !== "csv" && f !== "tsv" && f !== "json") usageError(`--format must be csv, tsv or json, got "${f}"`);
      opts.format = f;
    } else if (arg === "--schema") opts.schema = valueOf(i++, arg);
    else if (arg === "--out") opts.out = valueOf(i++, arg);
    else if (arg.startsWith("--")) usageError(`unknown option ${arg}`);
    else positional.push(arg);
  }
  if (positional.length !== 1 || positional[0].trim() === "") usageError("give exactly one SQL statement, quoted");
  opts.sql = positional[0];
  return opts;
}

const cell = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

function toCsv(columns: string[], rows: unknown[][]): string {
  const esc = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [columns.map(esc).join(","), ...rows.map((r) => r.map((v) => esc(cell(v))).join(","))].join("\n") + "\n";
}

function toTsv(columns: string[], rows: unknown[][]): string {
  const flat = (s: string) => s.replace(/[\t\r\n]+/g, " ");
  return [columns.map(flat).join("\t"), ...rows.map((r) => r.map((v) => flat(cell(v))).join("\t"))].join("\n") + "\n";
}

function toNdjson(columns: string[], rows: unknown[][]): string {
  return rows.map((r) => JSON.stringify(Object.fromEntries(columns.map((c, i) => [c, r[i] ?? null])))).join("\n") + (rows.length ? "\n" : "");
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  let port: number;
  try {
    port = loadServerConfig().ORACLE_MCP_PORT;
  } catch (err) {
    console.error(`oracle: ${(err as Error).message}`);
    process.exit(EXIT_UNAVAILABLE);
  }

  // Printing to a file costs no context, so there --out lifts the default cap.
  const limit = opts.limit ?? (opts.all || opts.out ? undefined : DEFAULT_LIMIT);

  let result: QueryResult | { success: false; error: string };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql: opts.sql, schema: opts.schema, limit }),
    });
    result = (await res.json()) as typeof result;
  } catch {
    console.error(`oracle: cannot reach the oracle query server on port ${port}. It must be running (see mcp-servers/oracle/README.md).`);
    process.exit(EXIT_UNAVAILABLE);
  }

  if (!result.success) {
    console.error(`oracle: ${result.error}`);
    process.exit("kind" in result && result.kind !== "sql" ? EXIT_UNAVAILABLE : EXIT_SQL);
  }

  if (result.columns.length === 0) {
    // DDL and the like: nothing to print, but say it ran.
    console.log("statement executed, no result set");
    return;
  }

  const format = { csv: toCsv, tsv: toTsv, json: toNdjson }[opts.format];
  const text = format(result.columns, result.rows);
  if (opts.out) {
    writeFileSync(opts.out, text);
    console.log(`wrote ${result.rows.length} row${result.rows.length === 1 ? "" : "s"} to ${opts.out}`);
  } else {
    process.stdout.write(text);
  }
  if (result.truncated) {
    console.error(
      `oracle: showing the first ${result.rows.length} rows, more exist. Narrow the query, raise --limit, or use --out FILE (the server caps one query at ORACLE_MAX_ROWS).`,
    );
  }
}

main().catch((err) => {
  console.error(`oracle: ${(err as Error).message}`);
  process.exit(EXIT_UNAVAILABLE);
});
