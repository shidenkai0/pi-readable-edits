# Labeling rubric: does this shell command edit project files?

Each line of a shard is `{ key, cwd, root, command }`: a shell command an AI coding agent ran from `cwd`, in the project whose root is `root`. The label records which files the command itself deliberately changes, the files a user would want to see a diff for. Those files can be anywhere, including outside `root` (a sibling worktree, `~/.config`), except scratch locations: temp directories (`/tmp`, `/private/tmp`, `/var/folders`, `$TMPDIR`), anything under `.git/` or `node_modules/`, and `*.log` files.

## `edit`

Running the command as written would leave at least one **file** outside scratch locations created, changed, deleted, renamed or copied, and that effect is **authored in the command**:

- Redirects (`>`, `>>`, `&>`, `>|`) and heredocs into files, `tee`.
- In-place editors: `sed -i`, `perl -i`, `ruby -i`, `awk -i inplace`, `ed`, `ex`.
- File operations on named files: `cp`, `mv`, `rm`, `touch`, `ln`, `install`, `truncate`, `git mv`, `git rm`.
- Patches supplied inline (`patch <<EOF`, `git apply <<EOF`).
- Programs whose source is in the command: `python -c`, `python - <<EOF`, `node -e`, heredoc scripts. Also scripts the command writes and then runs, like `cat > /tmp/fix.py <<EOF … EOF; python3 /tmp/fix.py`. Label the files the program writes.

Files written on only some branches (`if`/`else`, `||`) count too.

## `other`

- Read-only commands.
- Writes only to scratch locations.
- Files whose final state equals their initial state: created and removed again, or modified and then restored within the command.
- Output files named on a tool's command line (`curl -o`, `magick … out.png`, `rsvg-convert -o`, `pdftotext`, compilers' `-o`): the content is not authored in the command.
- Permission-only changes (`chmod`).
- Side effects of programs whose logic is not in the command:
  - formatters (`black`, `prettier --write`, `cargo fmt`) and linters with `--fix`;
  - builds, compilers, package managers and lockfile updates;
  - test runners (including snapshot updates), code generators and migrations;
  - Git operations other than `mv`/`rm` (`commit`, `checkout`, `restore`, `stash`, `reset`, `pull`, `merge`);
  - running a script file that the command did not write.
- Bulk tree operations: `rm -r`, `cp -r`, `mv` of a whole directory, `mkdir`.

## `uncertain`

You cannot tell whether the command changes files. Use sparingly.

## Fields

- `paths`: absolute paths of every non-scratch file the command would change.
  - Resolve relative paths against `cwd`, following any `cd` inside the command.
  - List files, not directories.
  - For a move or rename, list both the source and the destination.
  - Expand globs against the filesystem as it is now. Read-only inspection (`ls`, Glob, Read) is fine.
- `dynamic: true`: the set of edited files depends on runtime data that reading the command cannot reveal. Examples: `for f in $(git ls-files)`, `find … -exec sed -i`, a script walking a directory, paths taken from another command's output. List the paths you can determine, if any.
- `note`: at most 12 words. Required for `edit`, `uncertain` and `dynamic` entries.

Output one JSON array with exactly one object per shard line:

```json
[{ "key": 12, "kind": "edit", "paths": ["/abs/root/src/a.ts"], "note": "heredoc overwrites src/a.ts" },
 { "key": 13, "kind": "other", "paths": [] }]
```

`paths` is `[]` for `other` and `uncertain`.
