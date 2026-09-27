import assert from "node:assert/strict";
import { test } from "node:test";
import { isReadOnly } from "../scripts/readonly.js";

test("read-only classification skips only commands that provably cannot write", async () => {
  const readers = [
    "ls -la", "rg -n foo src | head -20", "git status --short && git diff --stat", "cat a.txt 2>/dev/null || echo missing",
    "sed -n '1,20p' file.ts", "cd src && grep -rn x .", "git log --oneline -5 2>&1", "echo $(git rev-parse HEAD)",
    "find . -name '*.ts' -not -path './node_modules/*'", "wc -l < file.txt", "git branch --show-current",
    "cat <<'EOF'\nhello\nEOF",
  ];
  const writers = [
    "echo hi > out.txt", "sed -i 's/a/b/' f", "find . -delete", "find . -exec rm {} +", "sort -o out.txt in.txt",
    "git checkout -- f", "git branch new-feature", "xargs rm < list", "cat a | tee b", "python3 script.py", "npm test",
    "echo $(rm -rf x)", "awk '{print > \"out\"}' f", "git config user.name x", "$EDITOR file", "uniq in out",
    "cat <<'EOF' > f\nx\nEOF", "ls; touch x",
  ];
  for (const command of readers) assert.equal(await isReadOnly(command), true, command);
  for (const command of writers) assert.equal(await isReadOnly(command), false, command);
});
