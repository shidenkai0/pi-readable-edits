# Readable edits for Pi

Show a file diff when an agent uses Bash to make a routine edit instead of Pi's edit tool.

Inline Python, `cat > file`, and in-place `sed` can leave you staring at a shell command with no clear view of what changed. This Pi extension recognizes common direct-write patterns, captures **only their resolved project files**, and adds their actual before/after diff to the Bash result. An unrecognized command runs and displays normally. This is a readability aid, not a filesystem audit.

## Try it

Requires Node.js, pnpm, and [Pi](https://pi.dev/).

```sh
pnpm install
pi --extension ./src/index.ts
```

The example loads the extension while Pi runs in this directory. To use it in another project, start Pi there with the **absolute path** to this repository's `src/index.ts`.

For example, a Bash call like `python3 -c 'from pathlib import Path; Path("app.ts").write_text("new")'` displays its normal output followed by an expandable diff for `app.ts`.

## What it recognizes

- Bash file redirects (`>`, `>>`, and heredocs), `tee`, BSD/GNU `sed -i`, and `perl -pi`.
- Embedded `python -c` or heredoc source: `open(..., "w"/"a"/"x")`, `Path.write_text`/`write_bytes`, and a small set of direct file operations. Inline Node.js `writeFile`/`writeFileSync` is also recognized.
- Literal paths, simple assignments, joins, finite lists, globs, and small local helpers. Paths are limited to the current Git worktree (or the Pi working directory outside Git).

Only changed, readable text files up to 256 KiB appear in the diff. Symlinks, external paths, binaries, and unresolved expressions retain the normal Bash display. Builds and tests are not analyzed for incidental output files. Diffs live in tool-result details for the UI, **not in model-facing output**. Large or unusual shell commands may have no diff.

## Develop and evaluate

```sh
task test       # unit and wrapped-Bash integration tests
task typecheck
task eval       # refresh private corpus; run labeled evaluation
task eval:full  # evaluate the frozen corpus against complete model labels
task check      # tests and typecheck; works without local transcripts
```

`task corpus` streams Bash calls from `~/.claude/projects` and `~/.codex/sessions`, taking the 12 most recently modified transcripts from each by default, plus sessions referenced by local labels. Set `CORPUS_SESSIONS=20` to widen the sample. The raw corpus and hand-labeled `.local/gold.json` stay under gitignored `.local/`; they may contain private commands and paths. `task eval` reports total Bash calls, resolved-target calls, parser time, and exact path-set accuracy **only for labeled calls**. Labels are curated rather than randomly sampled: their accuracy is not a population-wide coverage estimate.

To label your own calls, inspect `.local/corpus.jsonl` locally and add objects such as `{"id":"<command hash>","session":"<session filename>","paths":["src/file.ts"]}` to `.local/gold.json`. Paths are relative to each call's recorded working directory; use `[]` for a non-edit call. The evaluator prints target mismatches without writing transcript contents into the repository.

For a complete private reference set, freeze a corpus (`pnpm corpus .local/luna-corpus.jsonl`), run `task label:prepare`, and independently label each shard in `.local/labeling/shards/` as a JSON array in `.local/labeling/labels/` with `{ "key": 0, "kind": "edit", "paths": ["repo/relative.ts"] }`. Include *every* key; `other` has an empty path set, and `uncertain` flags unresolved direct project edits. These labels use **Git-root-relative paths**, unlike the older cwd-relative hand labels. Run `task label:normalize` to discard outside-root paths (recording each correction), then `task eval:full` to reject incomplete or misaligned labels and score the frozen calls. `task eval` still runs the separate curated hand-gold check. A model reference set is **not verified ground truth**; its scores must be read alongside a human audit and the hand-gold evaluation. Corpus contents and labels remain private in `.local/`.

### Frozen local evaluation

Corpus SHA-256 `0a4266587a5375d170dc4726101cc20ab34e8b71da943470aa1b291a4a1eeaa1`: 4,944 calls (Claude Code 1,154; Codex 3,790). Luna labeled 4,315 distinct command/working-directory pairs; duplicates expand to all 4,944 calls. After review of invalid paths and disagreements, labels classify 211 direct project-edit calls, 4,706 other calls, and 27 uncertain calls.

Against that **model-labeled reference**, `task eval:full` reports **192/211 (91.00%) complete edit target sets**, **1/4,706 negative calls with a candidate target**, and **263/265 (99.25%) path precision / 263/370 (71.08%) path recall**. The 27 uncertain calls are excluded from accuracy denominators. Parser time was 0.31 s total (0.06 ms/call); filesystem snapshot and command execution are not included. The one negative candidate creates and removes temporary project files within the same command, so it would not produce a final UI diff.

The separate curated hand set has 54/54 positive exact sets and 0/7 negative candidates, but is intentionally non-random and omits some copy targets. A 110-call deterministic stratified blind **same-model repeat** agreed on 107 labels after manual adjudication; that is a consistency check, not independent proof of ground-truth accuracy. Neither score establishes population-wide recall of edits Luna may have mislabeled as non-edits.

The current Pi TUI renders the diff on the Bash tool result. Other frontends must render the stored tool details themselves.
