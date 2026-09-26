import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { decode, MAX_TEXT_BYTES, type RawChange, type Side } from "./changes.js";
import { type BlobContent, EMPTY_OID, type GitSnapshots } from "./git.js";
import { extractTargets } from "./targets.js";

/** A capture opened before one or more overlapping commands and closed after the last one. */
export interface Capture {
  readonly mode: "git" | "targeted";
  /** Adds a command that joined the capture while it was open. */
  include(command: string, cwd: string): Promise<void>;
  finish(): Promise<RawChange[]>;
}

export class GitCapture implements Capture {
  readonly mode = "git";

  constructor(
    private readonly snapshots: GitSnapshots,
    private readonly before: string,
    private readonly takeSnapshot: () => Promise<string>,
  ) {}

  async include(): Promise<void> {
    // The whole worktree is already covered.
  }

  async finish(): Promise<RawChange[]> {
    const after = await this.takeSnapshot();
    const entries = await this.snapshots.diff(this.before, after);
    if (!entries.length) return [];
    const blobs = await this.snapshots.readBlobs(
      entries.flatMap((entry) => [entry.oldOid, entry.newOid]), MAX_TEXT_BYTES);
    const generated = await this.snapshots.generatedPaths(entries.map((entry) => entry.path));
    const root = this.snapshots.root;
    return entries.map((entry) => ({
      path: join(root, entry.path),
      ...(entry.oldPath ? { oldPath: join(root, entry.oldPath) } : {}),
      before: sideOf(entry.oldMode, entry.oldOid, blobs),
      after: sideOf(entry.newMode, entry.newOid, blobs),
      oldMode: entry.oldMode,
      newMode: entry.newMode,
      ...(generated.has(entry.path) ? { generated: true } : {}),
    }));
  }
}

function sideOf(mode: string, oid: string, blobs: Map<string, BlobContent>): Side {
  if (EMPTY_OID.test(oid) || mode === "000000") return { kind: "absent" };
  if (mode === "160000") return { kind: "submodule", commit: oid };
  const blob = blobs.get(oid);
  if (!blob || blob.kind === "missing") return { kind: "binary", size: 0 };
  if (blob.kind === "large") return { kind: "large", size: blob.size };
  if (mode === "120000") return { kind: "link", target: blob.bytes.toString() };
  return decode(blob.bytes);
}

/**
 * Fallback outside Git (or where Git snapshots are too slow): statically
 * resolve the files a command names, then compare their real contents.
 */
export class TargetedCapture implements Capture {
  readonly mode = "targeted";
  private readonly snapshots = new Map<string, Side>();

  private constructor(private readonly root: string, private readonly canonicalRoot: string) {}

  static async open(root: string): Promise<TargetedCapture> {
    return new TargetedCapture(root, await realpath(root));
  }

  async include(command: string, cwd: string): Promise<void> {
    let targets: string[] = [];
    try {
      targets = await extractTargets(command, cwd, this.root);
    } catch {
      return;
    }
    for (const path of targets) {
      if (this.snapshots.has(path) || !(await insideRoot(path, this.canonicalRoot))) continue;
      const side = await readSide(path);
      if (side) this.snapshots.set(path, side);
    }
  }

  async finish(): Promise<RawChange[]> {
    const changes: RawChange[] = [];
    for (const [path, before] of this.snapshots) {
      if (!(await insideRoot(path, this.canonicalRoot))) continue;
      const after = await readSide(path);
      if (!after || same(before, after)) continue;
      changes.push({ path, before, after });
    }
    return pairRenames(changes);
  }
}

function same(a: Side, b: Side): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "text" && b.kind === "text") return a.text === b.text;
  if (a.kind === "link" && b.kind === "link") return a.target === b.target;
  if (a.kind === "binary" && b.kind === "binary") return a.hash === b.hash;
  return a.kind === "absent";
}

/** `mv a b` appears as a deletion and an identical creation; show it as one rename. */
function pairRenames(changes: RawChange[]): RawChange[] {
  const created = changes.filter((change) => change.before.kind === "absent" && change.after.kind === "text");
  const result: RawChange[] = [];
  const used = new Set<RawChange>();
  for (const change of changes) {
    if (change.after.kind !== "absent" || change.before.kind !== "text") continue;
    const content = change.before.text;
    const match = created.find((candidate) => !used.has(candidate) &&
      candidate.after.kind === "text" && candidate.after.text === content);
    if (!match) continue;
    used.add(match).add(change);
    result.push({ path: match.path, oldPath: change.path, before: change.before, after: match.after });
  }
  return [...result, ...changes.filter((change) => !used.has(change))];
}

/** Missing files read as absent so creation and deletion diff correctly; unsupported files are skipped. */
async function readSide(path: string): Promise<Side | undefined> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return { kind: "link", target: await readlink(path) };
    if (!info.isFile()) return undefined;
    if (info.size > MAX_TEXT_BYTES) return { kind: "large", size: info.size };
    const bytes = await readFile(path);
    const side = decode(bytes);
    return side.kind === "binary" ? { ...side, hash: createHash("sha1").update(bytes).digest("hex") } : side;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : undefined;
  }
}

async function insideRoot(path: string, root: string): Promise<boolean> {
  let parent = dirname(path);
  while (true) {
    try {
      const rel = relative(root, await realpath(parent));
      return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === dirname(parent)) return false;
      parent = dirname(parent);
    }
  }
}
