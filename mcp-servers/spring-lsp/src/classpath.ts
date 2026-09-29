import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// What spring-boot-language-server asks a client for over its custom sts/addClasspathListener request:
// one event per project, delivered by calling back the command id it registered (workspace/executeCommand).
// The shape is ClasspathListener.Event in the vendored server (found by reading its classes).
interface ClasspathEntry {
  kind: "source" | "binary";
  path: string;
  outputFolder?: string;
  isSystem: boolean;
  isOwn: boolean;
  isTest: boolean;
  isJavaContent: boolean;
}

export interface ClasspathEvent {
  projectUri: string;
  name: string;
  deleted: boolean;
  classpath: { entries: ClasspathEntry[]; jre: { version: string; installationPath: string } };
  projectBuild: { type: string; buildFile: string };
  javaCoreOptions: Record<string, string>;
}

// Maven's own dependency:build-classpath, not a reimplementation of dependency resolution. On Windows mvn is
// mvn.cmd, which execFile can only run through a shell.
async function mavenClasspathJars(mavenCommand: string, projectRoot: string): Promise<string[]> {
  const outFile = path.join(tmpdir(), `spring-lsp-classpath-${process.pid}.txt`);
  const windows = process.platform === "win32";
  const outArg = `-Dmdep.outputFile=${windows ? `"${outFile}"` : outFile}`;
  try {
    await execFileAsync(mavenCommand, ["-q", "-B", "dependency:build-classpath", outArg], {
      cwd: projectRoot,
      shell: windows,
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const jars = (await readFile(outFile, "utf8")).trim();
    return jars ? jars.split(path.delimiter).filter(Boolean) : [];
  } finally {
    await rm(outFile, { force: true });
  }
}

async function javaSettings(javaExecutable: string): Promise<{ home: string; version: string }> {
  const { stderr } = await execFileAsync(javaExecutable, ["-XshowSettings:properties", "-version"], { timeout: 30_000 });
  const pick = (key: string) => new RegExp(`^\\s*${key.replaceAll(".", "\\.")} = (.+)$`, "m").exec(stderr)?.[1]?.trim() ?? "";
  return { home: pick("java.home"), version: pick("java.specification.version") };
}

export async function buildClasspathEvent(projectRoot: string, mavenCommand: string, javaExecutable: string): Promise<ClasspathEvent | undefined> {
  const pom = path.join(projectRoot, "pom.xml");
  if (!existsSync(pom)) return undefined; // Maven projects only
  const [jars, java] = await Promise.all([mavenClasspathJars(mavenCommand, projectRoot), javaSettings(javaExecutable)]);
  const entry = (kind: ClasspathEntry["kind"], p: string, extra: Partial<ClasspathEntry> = {}): ClasspathEntry => ({
    kind, path: p, isSystem: false, isOwn: false, isTest: false, isJavaContent: kind === "binary" || p.endsWith(`${path.sep}java`), ...extra,
  });
  const entries: ClasspathEntry[] = jars.map((j) => entry("binary", j));
  // The JDK's own classes: JDT's AST parser refuses to run ("Missing system library") without a system entry. On JDK 9+
  // that is the jrt-fs.jar filesystem provider, which reads the runtime image.
  const jrtFs = path.join(java.home, "lib", "jrt-fs.jar");
  if (existsSync(jrtFs)) entries.push(entry("binary", jrtFs, { isSystem: true }));
  for (const [rel, out, isTest] of [
    ["src/main/java", "target/classes", false],
    ["src/main/resources", "target/classes", false],
    ["src/test/java", "target/test-classes", true],
    ["src/test/resources", "target/test-classes", true],
  ] as const) {
    const dir = path.join(projectRoot, rel);
    if (existsSync(dir)) entries.push(entry("source", dir, { outputFolder: path.join(projectRoot, out), isOwn: true, isTest }));
  }
  return {
    projectUri: pathToFileURL(projectRoot).href,
    name: path.basename(projectRoot),
    deleted: false,
    classpath: { entries, jre: { version: java.version, installationPath: java.home } },
    projectBuild: { type: "maven", buildFile: pathToFileURL(pom).href },
    javaCoreOptions: {},
  };
}
