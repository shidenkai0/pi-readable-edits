# Working on readable edits

1. Never change how the shell tool runs or what the model sees. The extension observes tool events and adds user-facing session entries only. A snapshot failure must let the command run.
2. Never write to the user's index, object store or worktree. Git snapshots use the private index and object directory in `GitSnapshots`. `test/git.test.ts` checks this; keep it passing.
3. Compare real contents; don't predict edits. Git mode diffs trees. The fallback parser (`src/targets.ts`) may only name files supported by syntax and simple dataflow. Add a regression test for each new idiom. The read-only classifier must stay conservative: an unknown program counts as writing.
4. Review UI changes as images: `task preview` for card layouts, `task demo` for a real Pi run. Keep cards native to Pi: its theme colors, `renderDiff` and `keyHint`.
5. Run `task check` before claiming a change works. Report fallback-parser accuracy from `task eval` separately from the number of calls scanned.
6. Keep `.local/` private. It holds raw commands and labels from agent transcripts; commit synthetic fixtures instead.
