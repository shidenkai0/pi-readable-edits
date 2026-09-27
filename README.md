# Readable edits for Pi

When an agent edits files through `bash` (`sed -i`, a heredoc, a Python one-off), Pi shows you the command, not the change. This extension adds a diff card right after the command, in the same style as Pi's own `edit` tool.

![A diff card after a Python heredoc that edited three files](docs/card.png)

## Install

```sh
pi install git:github.com/shidenkai0/pi-readable-edits
```

Or try it for a single session without installing: `pi -e git:github.com/shidenkai0/pi-readable-edits`.

Nothing to configure. The card shows up the first time a shell command edits a file.

## What you see

- **The files the command edited:** creations, deletions, renames and binary files. One file gets a titled diff. Several get a file list with `+/−` counts, then a diff per file.
- **Pi's own diff rendering:** the same colors, line numbers and word-level highlights as the `edit` tool, with long lines wrapped under a hanging indent.
- **Short by default:** small diffs show in full. Large ones show a preview and expand with Pi's usual key (`ctrl+o`).
- **Safe to keep:** `.env*`, keys and credential files show line counts but never contents. Lockfiles and generated files stay collapsed.
- **Honest attribution:** a failed command is marked `failed`. Commands that ran in parallel share one card. Files that Pi's `edit`/`write` tools changed at the same time are left to those tools' own diffs.

The card is a session entry for you only. It is **never sent to the model**, and the command's own output is untouched.

## How it works

Before a shell command runs, the extension parses it (with tree-sitter; nothing is executed) for the files it writes. It reads those files, and after the command finishes, reads them again and shows what changed. It understands:

- Redirects and heredocs, `tee`, `sed -i`, `perl -i`, `cp`, `mv`, `rm`, `ln`, `git mv`, including variables, `~`, `$HOME`, brace lists, loops and globs.
- Python and Node code inside the command: `open(…, "w")`, `Path.write_text`, `shutil`, `os.rename`, `fs.writeFileSync`, `img.save(…)`, `df.to_csv(…)`, with the variables, loops, f-strings and path joins that feed them.
- Scripts the command writes and then runs, like `cat > /tmp/fix.py <<EOF … EOF; python3 /tmp/fix.py`.

It shows **deliberate edits only**. A formatter, build or package manager that rewrites files on its own isn't an edit the model wrote, so it stays out of the card, and so do writes to temp directories, `.git/`, `node_modules/` and `*.log`. Edits outside the project, like a sibling worktree or `~/.config`, do show.

It observes Pi's tool events instead of replacing the `bash` tool, so sandboxed, remote or custom-rendered `bash` implementations keep working. The overhead is a fraction of a millisecond per command: about 0.2 ms to parse, plus reading the files it names.

## Accuracy

Measured on 1,813 real Bash commands from Claude Code, Codex and Pi sessions, sampled per model family. The reference labels come from a model, with a second blind pass on every disagreement; they're a reference, not verified ground truth.

| Model family | Edit commands | Card shows every edited file | Cards with no wrong file |
|---|---|---|---|
| Claude | 119 | 96% | 97% |
| GPT | 64 | 89% | 97% |
| Kimi | 48 | 96% | 96% |
| GLM | 42 | 93% | 93% |
| DeepSeek | 5 | too few to score | |
| **Average of the four families** | 273 | **93%** | **96%** |

On sessions set aside while the parser was tuned, the average is 95%. Of the commands that could write but don't edit anything, about 1 in 200 gets a card; read-only commands never do. DeepSeek almost never edits through Bash; it uses Pi's `edit` tool.

What's missed: files whose names only exist at run time (`find … -exec`, paths read from another command's output, loops over computed lists), and programs that write files through their own logic (Blender, SQLite, a helper module).

## Commands

`/readable-edits off` and `/readable-edits on` pause and resume the cards.

## Limits

- Changes something else makes to the same files while a command runs (your editor, a watcher) appear in that command's card.
- Files over 1 MB and diffs too large to compute quickly are summarized instead of diffed.
- Cards render in Pi's terminal UI. They are stored in the session with diffs capped at 2,400 lines per card.

## Develop

From a checkout, `pnpm install`, then load your working copy with `pi -e "$PWD"`.

```sh
task check      # tests (parser, capture, tracker, rendering, extension) and typecheck
task preview    # render sample cards to .scratch/cards.png with Pi's real theme
task demo       # run real Pi with a scripted model; screenshots in .scratch/
task eval       # score the parser against your local, private labeled sample
```

`task demo` drives a real Pi TUI in a pseudo-terminal with a scripted model (`scripts/demo/`). It uses an isolated config directory, so your personal Pi settings and extensions don't leak in. It needs [`uv`](https://docs.astral.sh/uv/). It is also how `docs/card.png` is made.

### Evaluation

The eval runs on your own transcripts and keeps everything in the gitignored `.local/`:

1. `task corpus` streams Bash calls from `~/.claude/projects`, `~/.codex/sessions` and `~/.pi/agent/sessions`.
2. `task eval:sample` draws up to 380 commands per model family. Provably read-only commands are skipped; commands that look like writes are oversampled, and the rest are sampled lightly to catch what that filter misses.
3. Label the shards in `.local/eval/shards/` with [`scripts/eval-rubric.md`](scripts/eval-rubric.md), into `.local/eval/labels/`.
4. `task eval` reports each family and the average across families, reweighted to each family's real mix of commands. Add `--misses` or `--false-cards` to list them, or `--split holdout` to score only the held-out sessions.
