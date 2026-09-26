import { realpath } from "node:fs/promises";
import { type Capture, GitCapture, TargetedCapture } from "./capture.js";
import { findRepository, GitSnapshots, GitTimeoutError, type Repository } from "./git.js";
import { scopeRoot } from "./targets.js";

/** A snapshot slower than this counts against the repository. */
export const SLOW_SNAPSHOT_MS = 1500;
/** A snapshot is abandoned (and the command runs anyway) after this long. */
export const SNAPSHOT_TIMEOUT_MS = 4000;
const STRIKES_BEFORE_FALLBACK = 2;

export interface RepositoryStatus {
  root: string;
  mode: "git" | "targeted";
  reason?: string;
  snapshots: number;
  averageMs: number;
}

interface RepositoryState {
  repository: Repository;
  snapshots?: Promise<GitSnapshots>;
  strikes: number;
  count: number;
  totalMs: number;
  fallbackReason?: string;
}

/**
 * Chooses how to observe a command's edits: a whole-worktree Git snapshot when
 * the command runs inside a Git worktree, or statically resolved targets
 * elsewhere. Repositories whose snapshots are too slow degrade to targets.
 */
export interface EngineOptions {
  slowSnapshotMs?: number;
  snapshotTimeoutMs?: number;
}

export class Engine {
  private readonly repositories = new Map<string, Promise<RepositoryState | undefined>>();
  private readonly byRoot = new Map<string, RepositoryState>();
  private readonly slowMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly notice: (message: string) => void = () => {}, options: EngineOptions = {}) {
    this.slowMs = options.slowSnapshotMs ?? SLOW_SNAPSHOT_MS;
    this.timeoutMs = options.snapshotTimeoutMs ?? SNAPSHOT_TIMEOUT_MS;
  }

  async start(command: string, directory: string): Promise<Capture> {
    // Git reports canonical paths, so parse and compare from the canonical directory too.
    const cwd = await realpath(directory).catch(() => directory);
    const state = await this.repositoryFor(cwd);
    if (state && !state.fallbackReason) {
      try {
        const snapshots = await (state.snapshots ??= GitSnapshots.open(state.repository));
        const take = () => this.timed(state, () => snapshots.snapshot({ timeoutMs: this.timeoutMs }));
        return new GitCapture(snapshots, await take(), take);
      } catch (error) {
        this.fallBack(state, error instanceof GitTimeoutError
          ? `Git snapshots took over ${this.timeoutMs / 1000}s`
          : `Git snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const capture = await TargetedCapture.open(state?.repository.root ?? await scopeRoot(cwd));
    await capture.include(command, cwd);
    return capture;
  }

  status(): RepositoryStatus[] {
    return [...this.byRoot.values()].map((state) => ({
      root: state.repository.root,
      mode: state.fallbackReason ? "targeted" : "git",
      ...(state.fallbackReason ? { reason: state.fallbackReason } : {}),
      snapshots: state.count,
      averageMs: state.count ? Math.round(state.totalMs / state.count) : 0,
    }));
  }

  async dispose(): Promise<void> {
    const states = [...this.byRoot.values()];
    this.repositories.clear();
    this.byRoot.clear();
    await Promise.all(states.map(async (state) => (await state.snapshots?.catch(() => undefined))?.dispose()));
  }

  private repositoryFor(cwd: string): Promise<RepositoryState | undefined> {
    let found = this.repositories.get(cwd);
    if (!found) {
      found = findRepository(cwd).then((repository) => {
        if (!repository) return undefined;
        const existing = this.byRoot.get(repository.root);
        if (existing) return existing;
        const state: RepositoryState = { repository, strikes: 0, count: 0, totalMs: 0 };
        this.byRoot.set(repository.root, state);
        return state;
      });
      this.repositories.set(cwd, found);
    }
    return found;
  }

  private async timed<T>(state: RepositoryState, task: () => Promise<T>): Promise<T> {
    const started = performance.now();
    const result = await task();
    const elapsed = performance.now() - started;
    state.count++;
    state.totalMs += elapsed;
    state.strikes = elapsed > this.slowMs ? state.strikes + 1 : 0;
    if (state.strikes >= STRIKES_BEFORE_FALLBACK) {
      this.fallBack(state, `Git snapshots average ${Math.round(state.totalMs / state.count)}ms here`);
    }
    return result;
  }

  private fallBack(state: RepositoryState, reason: string): void {
    if (state.fallbackReason) return;
    state.fallbackReason = reason;
    this.notice(`${reason}; showing diffs only for files commands name directly.`);
  }
}

