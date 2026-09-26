import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const EMPTY_OID = /^0+$/;

export interface GitResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

export interface GitOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
}

/** Variables that would redirect Git away from the repository we inspect. */
const INHERITED_GIT_VARIABLES = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_PREFIX", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM",
];

export function cleanEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of INHERITED_GIT_VARIABLES) delete env[name];
  return { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...extra };
}

export function git(args: string[], options: GitOptions): Promise<GitResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd: options.cwd,
      env: options.env ?? cleanEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stderr = "";
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs)
      : undefined;
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 8192) stderr += chunk.toString(); });
    child.on("error", (error) => { if (timer) clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) reject(new GitTimeoutError(args[0] ?? "git", options.timeoutMs!));
      else resolvePromise({ code: code ?? 1, stdout: Buffer.concat(stdout), stderr });
    });
    child.stdin.on("error", () => { /* Git may exit before reading all input. */ });
    child.stdin.end(options.input ?? "");
  });
}

export class GitTimeoutError extends Error {
  constructor(command: string, readonly timeoutMs: number) {
    super(`git ${command} exceeded ${timeoutMs}ms`);
  }
}

async function checked(args: string[], options: GitOptions): Promise<Buffer> {
  const result = await git(args, options);
  if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  return result.stdout;
}

export interface Repository {
  root: string;
  objects: string;
  index: string;
}

/** Locate the worktree that contains `cwd`, or undefined outside a non-bare Git worktree. */
export async function findRepository(cwd: string): Promise<Repository | undefined> {
  try {
    const out = await git(
      ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-path", "objects", "--git-path", "index"],
      { cwd, timeoutMs: 5000 },
    );
    if (out.code !== 0) return undefined;
    const [root, objects, index] = out.stdout.toString().trim().split("\n");
    return root && objects && index ? { root, objects, index } : undefined;
  } catch {
    return undefined;
  }
}

/** One raw entry from `git diff-tree --raw`. */
export interface RawEntry {
  status: "A" | "M" | "D" | "R" | "T";
  oldMode: string;
  newMode: string;
  oldOid: string;
  newOid: string;
  path: string;
  oldPath?: string;
}

export function parseRawDiff(output: Buffer): RawEntry[] {
  const fields = output.toString("utf8").split("\0");
  const entries: RawEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const header = fields[i];
    if (!header.startsWith(":")) continue;
    const [oldMode, newMode, oldOid, newOid, rawStatus] = header.slice(1).split(" ");
    const letter = rawStatus?.[0];
    if (letter === "R" || letter === "C") {
      const from = fields[++i], to = fields[++i];
      // A copy leaves its source unchanged, so it reads as a plain addition.
      entries.push(letter === "R"
        ? { status: "R", oldMode, newMode, oldOid, newOid, oldPath: from, path: to }
        : { status: "A", oldMode: "000000", newMode, oldOid: "0".repeat(oldOid.length), newOid, path: to });
    } else if (letter === "A" || letter === "M" || letter === "D" || letter === "T") {
      entries.push({ status: letter, oldMode, newMode, oldOid, newOid, path: fields[++i] });
    } else {
      i++; // Unmerged or unknown entries carry one path.
    }
  }
  return entries;
}

export type BlobContent = { kind: "data"; bytes: Buffer } | { kind: "large"; size: number } | { kind: "missing" };

export interface SnapshotOptions {
  /** Abort a snapshot that takes longer than this; the caller falls back. */
  timeoutMs: number;
}

const STATE_PREFIX = "pi-readable-edits-";

/**
 * Snapshots a worktree without touching the user's index or object store.
 *
 * Each snapshot stages the complete worktree into a private index (seeded from
 * the real index so Git's stat cache keeps it fast) and writes new blobs into a
 * private object directory that borrows the repository's objects as an
 * alternate. `.gitignore` decides what counts, exactly as `git status` would.
 */
export class GitSnapshots {
  private queue: Promise<unknown> = Promise.resolve();
  private seeded = false;

  private constructor(
    readonly repository: Repository,
    private readonly stateDir: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  static async open(repository: Repository): Promise<GitSnapshots> {
    const stateDir = await mkdtemp(join(tmpdir(), `${STATE_PREFIX}${process.pid}-`));
    const objects = join(stateDir, "objects");
    await mkdir(objects, { recursive: true });
    const config = await neutralConfig(repository.root);
    const env = cleanEnvironment({
      GIT_INDEX_FILE: join(stateDir, "index"),
      GIT_OBJECT_DIRECTORY: objects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: alternatePath(repository.objects),
      // Environment config reaches every Git process, including write-tree's index refresh.
      ...environmentConfig(config),
    });
    return new GitSnapshots(repository, stateDir, env);
  }

  get root(): string {
    return this.repository.root;
  }

  /** Snapshots are serialized: they share one private index. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Returns the tree object for the current worktree contents. */
  snapshot(options: SnapshotOptions): Promise<string> {
    return this.exclusive(async () => {
      const started = Date.now();
      const remaining = () => Math.max(1, options.timeoutMs - (Date.now() - started));
      if (!this.seeded) {
        this.seeded = true;
        await copyFile(this.repository.index, join(this.stateDir, "index")).catch(() => undefined);
      }
      // --ignore-errors keeps one unreadable file from hiding every other change.
      await git(["add", "--all", "--ignore-errors", "--", ":/"],
        { cwd: this.root, env: this.env, timeoutMs: remaining() });
      return (await checked(["write-tree"], { cwd: this.root, env: this.env, timeoutMs: remaining() })).toString().trim();
    });
  }

  async diff(from: string, to: string): Promise<RawEntry[]> {
    if (from === to) return [];
    const out = await checked(
      ["diff-tree", "-r", "-z", "--raw", "--no-commit-id", "--find-renames", "--abbrev=40", from, to],
      { cwd: this.root, env: this.env, timeoutMs: 15_000 },
    );
    return parseRawDiff(out);
  }

  /** Reads blobs up to `maxBytes`; larger blobs report their size only. */
  async readBlobs(oids: string[], maxBytes: number): Promise<Map<string, BlobContent>> {
    const result = new Map<string, BlobContent>();
    const wanted = [...new Set(oids.filter((oid) => !EMPTY_OID.test(oid)))];
    if (!wanted.length) return result;
    const sizes = await checked(["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
      { cwd: this.root, env: this.env, input: wanted.join("\n") + "\n", timeoutMs: 15_000 });
    const small: string[] = [];
    for (const line of sizes.toString().split("\n")) {
      const [oid, type, size] = line.split(" ");
      if (!oid) continue;
      if (type !== "blob") result.set(oid, { kind: "missing" });
      else if (Number(size) > maxBytes) result.set(oid, { kind: "large", size: Number(size) });
      else small.push(oid);
    }
    if (!small.length) return result;
    const out = await checked(["cat-file", "--batch"],
      { cwd: this.root, env: this.env, input: small.join("\n") + "\n", timeoutMs: 15_000 });
    let offset = 0;
    while (offset < out.length) {
      const newline = out.indexOf(10, offset);
      if (newline < 0) break;
      const [oid, type, size] = out.subarray(offset, newline).toString().split(" ");
      offset = newline + 1;
      if (type === "missing" || size === undefined) { result.set(oid, { kind: "missing" }); continue; }
      const length = Number(size);
      result.set(oid, { kind: "data", bytes: out.subarray(offset, offset + length) });
      offset += length + 1;
    }
    return result;
  }

  /** Returns paths Git marks as generated through `linguist-generated` or `-diff`. */
  async generatedPaths(paths: string[]): Promise<Set<string>> {
    const generated = new Set<string>();
    if (!paths.length) return generated;
    try {
      const out = await checked(["check-attr", "-z", "--stdin", "linguist-generated", "diff"],
        { cwd: this.root, env: this.env, input: paths.join("\0") + "\0", timeoutMs: 5000 });
      const fields = out.toString().split("\0");
      for (let i = 0; i + 2 < fields.length; i += 3) {
        const [path, attribute, value] = [fields[i], fields[i + 1], fields[i + 2]];
        if ((attribute === "linguist-generated" && (value === "set" || value === "true")) ||
            (attribute === "diff" && value === "unset")) generated.add(path);
      }
    } catch { /* Attributes are a presentation hint only. */ }
    return generated;
  }

  async dispose(): Promise<void> {
    await this.queue.catch(() => undefined);
    await rm(this.stateDir, { recursive: true, force: true });
  }
}

/** Appends to any GIT_CONFIG_COUNT entries the user already exports rather than replacing them. */
function environmentConfig(config: Array<[string, string]>): NodeJS.ProcessEnv {
  const existing = Number(process.env.GIT_CONFIG_COUNT) || 0;
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: String(existing + config.length) };
  config.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${existing + i}`] = key;
    env[`GIT_CONFIG_VALUE_${existing + i}`] = value;
  });
  return env;
}

/** Git splits alternates on the path delimiter unless the entry is C-quoted. */
function alternatePath(path: string): string {
  return /[:;"\\]/.test(path) ? `"${path.replace(/["\\]/g, "\\$&")}"` : path;
}

/**
 * Clean/smudge filters (Git LFS and friends) may be slow, write outside the
 * private object store, or fail when required. Snapshots only need raw bytes.
 */
async function neutralConfig(root: string): Promise<Array<[string, string]>> {
  const config: Array<[string, string]> = [
    ["core.safecrlf", "false"], ["advice.addEmbeddedRepo", "false"], ["advice.addIgnoredFile", "false"],
  ];
  try {
    const out = await git(["config", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"],
      { cwd: root, timeoutMs: 5000 });
    const drivers = new Set(out.stdout.toString().split("\n")
      .map((name) => name.match(/^filter\.(.+)\.(?:clean|smudge|process|required)$/)?.[1])
      .filter((name): name is string => !!name));
    for (const driver of drivers) {
      config.push([`filter.${driver}.clean`, ""], [`filter.${driver}.process`, ""], [`filter.${driver}.required`, "false"]);
    }
  } catch { /* No filters configured. */ }
  return config;
}

/** Removes private snapshot state left behind by Pi processes that no longer exist. */
export async function sweepStaleState(): Promise<void> {
  try {
    for (const name of await readdir(tmpdir())) {
      if (!name.startsWith(STATE_PREFIX)) continue;
      const pid = Number(name.slice(STATE_PREFIX.length).split("-")[0]);
      if (!pid || pid === process.pid || alive(pid)) continue;
      const path = join(tmpdir(), name);
      if ((await stat(path)).isDirectory()) await rm(path, { recursive: true, force: true });
    }
  } catch { /* Best effort. */ }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
