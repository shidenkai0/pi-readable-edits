# Working on readable edits

1. Never change how the shell tool runs or what the model sees. The extension observes tool events and adds user-facing session entries only. A capture failure must let the command run.
2. Cards show deliberate edits: files the command itself names, found by statically parsing it (`src/targets.ts`). Never guess. Name only files supported by syntax and simple dataflow, and add a regression test for each new idiom. Programs that rewrite files on their own (formatters, builds) stay out by design.
3. Compare real contents; don't predict edits. The capture reads each named file before the command runs and after it finishes.
4. Review UI changes as images: `task preview` for card layouts, `task demo` for a real Pi run. Keep cards native to Pi: its theme colors, `renderDiff` and `keyHint`.
5. Run `task check` before claiming a change works. Report parser accuracy from `task eval` per model family and overall, and say the reference labels come from a model.
6. Keep `.local/` private. It holds raw commands and labels from agent transcripts; commit synthetic fixtures instead.
