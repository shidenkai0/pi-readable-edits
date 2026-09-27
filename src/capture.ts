import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { decode, MAX_TEXT_BYTES, type RawChange, type Side } from "./changes.js";
import { extractTargets, isIgnored } from "./targets.js";

/**
 * Records the files one or more overlapping commands name, before they run,
 * and compares them after the last one finishes.
 *
 * Targets come from statically parsing each command, so only deliberate
 * edits appear: a formatter or build that rewrites files is not an edit the
 * model wrote, and stays out of the card.
 */
export class FileCapture {
  private readonly snapshots = new Map<string, Side>();

  static async start(command: string, cwd: string): Promise<FileCapture> {
    const capture = new FileCapture();
    await capture.include(command, cwd);
    return capture;
  }

  /** Adds a command that joined the capture while it was open. */
  async include(command: string, cwd: string): Promise<void> {
    let targets: string[] = [];
    try {
      targets = await extractTargets(command, cwd);
    } catch {
      return;
    }
    for (const path of targets) {
      if (this.snapshots.has(path) || !(await watched(path, cwd))) continue;
      const side = await readSide(path);
      if (side) this.snapshots.set(path, side);
    }
  }

  async finish(): Promise<RawChange[]> {
    const changes: RawChange[] = [];
    for (const [path, before] of this.snapshots) {
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

/** Resolves symlinked parents, so a path that leads into a temp directory still counts as scratch. */
async function watched(path: string, cwd: string): Promise<boolean> {
  let parent = dirname(path);
  while (true) {
    try {
      return !isIgnored(join(await realpath(parent), basename(path)), await realpath(cwd).catch(() => cwd));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === dirname(parent)) return false;
      parent = dirname(parent);
    }
  }
}
