import type { Node as SyntaxNode } from "web-tree-sitter";
import { literalWord, parseShell } from "../src/targets.js";

// Eval tooling only: the sampler treats provably read-only commands as non-edits.
// The extension itself doesn't need this; the parser finds no targets in them.

const MAX_VISITS = 8192;

/** Programs that never write files, given the argument checks in `readOnlyInvocation`. */
const READ_ONLY_PROGRAMS = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "ag", "fd", "tree", "pwd", "echo", "printf",
  "which", "type", "command", "file", "stat", "du", "df", "jq", "cut", "tr", "diff", "cmp", "basename", "dirname",
  "realpath", "readlink", "date", "true", "false", "test", "[", "sleep", "nl", "column", "od", "hexdump", "md5",
  "md5sum", "shasum", "sha256sum", "ps", "whoami", "uname", "id", "hostname", "nproc", "cd", "less", "more", "bat",
  "sed", "awk", "sort", "find", "git", "uniq",
]);
const READ_ONLY_GIT = new Set([
  "status", "log", "diff", "show", "rev-parse", "ls-files", "ls-tree", "blame", "describe", "shortlog", "grep",
  "cat-file", "rev-list", "merge-base", "branch", "remote", "config", "reflog", "name-rev", "for-each-ref",
]);

function readOnlyInvocation(name: string, args: Array<string | undefined>): boolean {
  if (!READ_ONLY_PROGRAMS.has(name)) return false;
  const has = (pattern: RegExp) => args.some((arg) => arg === undefined || pattern.test(arg));
  switch (name) {
    case "sed": return !has(/^-[a-zA-Z]*i|^--in-place/) && !has(/^-[a-zA-Z]*[wW]/) && !args.some((arg) => arg && /(^|;|\s)w\s/.test(arg));
    case "awk": return !has(/^-i|inplace/) && !args.some((arg) => arg && />|system|print\s*>/.test(arg));
    case "sort": return !has(/^-[a-zA-Z]*o|^--output/);
    case "uniq": return args.filter((arg) => arg && !arg.startsWith("-")).length <= 1;
    case "find": return !has(/^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/);
    case "git": {
      const sub = args.find((arg) => arg && !arg.startsWith("-"));
      if (!sub || !READ_ONLY_GIT.has(sub)) return false;
      if (sub === "branch" || sub === "remote" || sub === "config") {
        // Listing forms only; these subcommands also have writing forms.
        return args.slice(args.indexOf(sub) + 1).every((arg) => arg !== undefined && /^(-[alrv]+|--(list|all|show-current|get\S*|verbose))$/.test(arg));
      }
      return !has(/^--output/);
    }
    default: return true;
  }
}

/**
 * True when the command provably cannot change project files: every program
 * is a known reader, and every redirect is an input, a descriptor duplicate,
 * or /dev/null. Anything unrecognized counts as writing.
 */
export async function isReadOnly(command: string): Promise<boolean> {
  const root = await parseShell(command);
  if (!root) return false;
  let visits = 0;
  const safe = (node: SyntaxNode): boolean => {
    if (++visits > MAX_VISITS) return false;
    switch (node.type) {
      case "program": case "list": case "pipeline": case "subshell": case "compound_statement": case "negated_command":
      case "redirected_statement": case "command_substitution": case "string": case "concatenation": case "word":
      case "raw_string": case "string_content": case "simple_expansion": case "expansion": case "variable_name":
      case "number": case "comment": case "heredoc_redirect": case "heredoc_start": case "heredoc_body": case "heredoc_end":
      case "herestring_redirect": case "ansi_c_string": case "special_variable_name": case "command_name":
        return node.namedChildren.every(safe);
      case "file_redirect": {
        const operator = node.text.trim().replace(/^\d+/, "");
        if (operator.startsWith("<")) return true;
        if (/^>&\d*-?$|^>&\s*\d+$/.test(operator)) return true;
        return node.childForFieldName("destination")?.text === "/dev/null";
      }
      case "command": {
        const nameNode = node.childForFieldName("name");
        if (!nameNode || nameNode.namedChildren[0]?.type !== "word") return false;
        const name = nameNode.text.split("/").pop()!;
        const argNodes = node.namedChildren.filter((child) => child.type !== "command_name");
        const args = argNodes.map(literalWord);
        return readOnlyInvocation(name, args) && argNodes.every(safe);
      }
      default:
        return false;
    }
  };
  return safe(root);
}
