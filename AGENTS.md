# Working on readable edits

1. Keep Pi's original `bash` execution and model-facing output intact. A recognized direct edit may add a user-facing diff; an unresolved command remains an ordinary Bash call.
2. Add a parser regression test for each new write idiom. Resolve only paths supported by syntax and simple dataflow; compare actual contents after execution rather than predicting the edit.
3. Run `task check` before claiming a change works. `task eval` refreshes local Bash calls from Codex and Claude Code; report labeled accuracy separately from the number of calls merely scanned.
4. Keep `.local/` private. It contains raw tool commands and local labels from agent transcripts; commit synthetic test fixtures instead.
