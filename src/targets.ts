import { opendirSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import fg from "fast-glob";
import { Language, Parser, type Node as SyntaxNode } from "web-tree-sitter";

type Value =
  | { kind: "text"; text: string }
  | { kind: "sequence"; items: Value[] }
  | { kind: "mapping"; entries: Array<[Value, Value]> }
  | { kind: "unknown" };
type Environment = Map<string, Value>;

const MAX_COMMAND_BYTES = 512_000;
const MAX_TARGETS = 128;
const MAX_VISITS = 8192;
const MAX_GLOB_ENTRIES = 4096;
const UNKNOWN: Value = { kind: "unknown" };
const text = (value: string): Value => ({ kind: "text", text: value });
const sequence = (items: Value[]): Value | undefined =>
  items.length <= MAX_TARGETS ? { kind: "sequence", items } : undefined;
const strings = (value: Value | undefined): string[] | undefined =>
  value?.kind === "text" ? [value.text] :
  value?.kind === "sequence" && value.items.every((item) => item.kind === "text")
    ? value.items.map((item) => (item as { kind: "text"; text: string }).text) : undefined;
const scalar = (value: Value | undefined): string | undefined =>
  value?.kind === "text" ? value.text : undefined;
let parsers: Promise<{ bash: Parser; python: Parser; javascript: Parser }> | undefined;

async function getParsers(): Promise<{ bash: Parser; python: Parser; javascript: Parser }> {
  parsers ??= (async () => {
    await Parser.init();
    const require = createRequire(import.meta.url);
    const wasmDirectory = dirname(require.resolve("@vscode/tree-sitter-wasm"));
    const load = async (name: string) => {
      const parser = new Parser();
      parser.setLanguage(await Language.load(join(wasmDirectory, `tree-sitter-${name}.wasm`)));
      return parser;
    };
    return { bash: await load("bash"), python: await load("python"), javascript: await load("javascript") };
  })();
  return parsers;
}

function field(node: SyntaxNode, name: string): SyntaxNode | null {
  return node.childForFieldName(name);
}

function literal(text: string): string | undefined {
  // A deliberately small literal evaluator, not a Python or shell interpreter.
  const match = text.match(/^(?:[rRuU])?(['"]{1,3})([\s\S]*)(\1)$/);
  if (!match) return undefined;
  const [, quote, body] = match;
  if (quote.startsWith('"')) {
    try {
      return JSON.parse(`"${body}"`);
    } catch {
      return undefined;
    }
  }
  return body.replace(/\\(['\\])/g, "$1").replace(/\\n/g, "\n");
}

function shellValue(node: SyntaxNode | null, env: Environment): Value | undefined {
  if (!node) return undefined;
  if (node.type === "command_name") return shellValue(node.namedChildren[0], env);
  if (node.type === "raw_string") {
    // Single-quoted shell words preserve backslashes verbatim, unlike Python.
    return text(node.text.slice(1, -1));
  }
  if (node.type === "array") {
    const items = node.namedChildren.map((child) => shellValue(child, env));
    return items.every((item) => item !== undefined) ? sequence(items as Value[]) : undefined;
  }
  if (node.type === "simple_expansion" || node.type === "expansion") {
    const variable = node.namedChildren[0];
    if (variable?.type === "variable_name") return env.get(variable.text);
    if (variable?.type === "subscript" && field(variable, "index")?.text === "@") {
      return env.get(field(variable, "name")?.text ?? "");
    }
    return undefined;
  }
  if (node.type === "number") return text(node.text);
  if (node.type === "concatenation" || node.type === "word") {
    // Bash splits `src/{a,b}.ts` into words like `{a` and `,b}`. Expand plain literal lists only.
    const braced = node.type === "word" ? /\{[^}]*,/.test(node.text)
      : node.namedChildren.some((child) => child.type === "brace_expression" || (child.type === "word" && /[{}]/.test(child.text)));
    if (braced) {
      if (/['"$`\\]/.test(node.text)) return undefined;
      const words = expandBraces(node.text.replace(/^~(?=\/|$)/, homedir()));
      return words ? (words.length === 1 ? text(words[0]!) : sequence(words.map(text))) : undefined;
    }
  }
  if (node.type === "concatenation") {
    // 'it'"'"'s' and similar quoting tricks: join the parts when each is a single string.
    const parts = node.namedChildren.map((child) => scalar(shellValue(child, env)));
    return parts.every((part) => part !== undefined) ? text(parts.join("")) : undefined;
  }
  if (node.type !== "word" && node.type !== "string") return undefined;
  const start = node.type === "string" ? 1 : 0;
  const end = node.type === "string" ? node.text.length - 1 : node.text.length;
  let pieces = [""];
  let offset = start;
  for (const child of node.namedChildren) {
    const before = node.text.slice(offset, child.startIndex - node.startIndex);
    if (/[`$]/.test(before)) return undefined;
    pieces = pieces.map((part) => part + before);
    const value = child.type === "string_content" ? text(child.text) : shellValue(child, env);
    const parts = strings(value);
    if (!parts || pieces.length * parts.length > MAX_TARGETS) return undefined;
    // Bash "${array[@]}suffix" does not append the suffix to each element.
    if (parts.length > 1 && (pieces.some((part) => part !== "") || child.endIndex - node.startIndex !== end)) return undefined;
    pieces = pieces.flatMap((part) => parts.map((item) => part + item));
    offset = child.endIndex - node.startIndex;
  }
  const tail = node.text.slice(offset, end);
  if (/[`$]/.test(tail)) return undefined;
  pieces = pieces.map((part) => (part + tail).replace(/\\(["\\$`])/g, "$1").replace(/\\\n/g, ""));
  // Tilde expansion applies to unquoted words only.
  if (node.type === "word" && /^~(?:\/|$)/.test(node.text)) pieces = pieces.map((part) => homedir() + part.slice(1));
  return pieces.length === 1 ? text(pieces[0]) : sequence(pieces.map(text));
}

function expand(pattern: string, cwd: string): string[] {
  if (!/[*?[\]]/.test(pattern)) return [pattern];
  // Recursive globs are unbounded; so are wildcards directly under / or ~.
  if (pattern.includes("**")) return [];
  const parts = pattern.split("/");
  const literal = parts.slice(0, parts.findIndex((part) => /[*?[\]{}]/.test(part))).join("/");
  const base = resolve(cwd, literal || ".");
  if (base === "/" || base === homedir()) return [];
  let entries;
  try {
    entries = opendirSync(base);
    let count = 0;
    while (entries.readSync()) if (++count > MAX_GLOB_ENTRIES) return [];
  } catch {
    return [];
  } finally {
    try { entries?.closeSync(); } catch { /* already closed at EOF */ }
  }
  return fg.sync(pattern, {
    cwd, dot: true, onlyFiles: true, followSymbolicLinks: false, deep: parts.length,
    ignore: ["**/.git/**", "**/node_modules/**"],
  }).slice(0, MAX_TARGETS);
}

/** Expands `{a,b}` lists in a literal word, as Bash does before anything else. */
function expandBraces(word: string): string[] | undefined {
  const open = word.indexOf("{");
  if (open < 0) return [word];
  let depth = 0, close = -1;
  const commas: number[] = [];
  for (let i = open; i < word.length && close < 0; i++) {
    if (word[i] === "{") depth++;
    else if (word[i] === "}" && --depth === 0) close = i;
    else if (word[i] === "," && depth === 1) commas.push(i);
  }
  if (close < 0 || !commas.length) return undefined; // Sequences like {1..3} and stray braces are not modeled.
  const options = [open, ...commas].map((start, index) => word.slice(start + 1, [...commas, close][index]));
  const results: string[] = [];
  for (const option of options) {
    const expanded = expandBraces(word.slice(0, open) + option + word.slice(close + 1));
    if (!expanded || results.length + expanded.length > MAX_TARGETS) return undefined;
    results.push(...expanded);
  }
  return results;
}

function argsOf(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((child) => child.type !== "command_name");
}

function evalPython(node: SyntaxNode | null, env: Environment, cwd: string, depth = 0): Value | undefined {
  if (!node || depth > 16) return undefined;
  const evaluate = (child: SyntaxNode | null) => evalPython(child, env, cwd, depth + 1);
  if (node.type === "string") {
    if (node.namedChildren.some((child) => child.type === "interpolation")) {
      let result = "";
      for (const child of node.namedChildren) {
        if (child.type === "string_content") result += child.text;
        else if (child.type === "interpolation") {
          const part = scalar(evaluate(field(child, "expression")));
          if (part === undefined) return undefined;
          result += part;
        }
      }
      return text(result);
    }
    const value = literal(node.text);
    return value === undefined ? undefined : text(value);
  }
  if (node.type === "identifier") return env.get(node.text);
  if (node.type === "parenthesized_expression") return evaluate(node.namedChildren[0]);
  if (node.type === "list" || node.type === "tuple") {
    if (node.namedChildren.length > MAX_TARGETS) return undefined;
    return sequence(node.namedChildren.map((item) => evaluate(item) ?? UNKNOWN));
  }
  if (node.type === "dictionary") {
    if (node.namedChildren.length > MAX_TARGETS) return undefined;
    const entries: Array<[Value, Value]> = [];
    for (const pair of node.namedChildren) {
      if (pair.type !== "pair") return undefined;
      const key = evaluate(field(pair, "key"));
      if (!key || key.kind !== "text") return undefined;
      entries.push([key, evaluate(field(pair, "value")) ?? UNKNOWN]);
    }
    return { kind: "mapping", entries };
  }
  if (node.type === "binary_operator") {
    const left = evaluate(field(node, "left"));
    const right = evaluate(field(node, "right"));
    const operator = node.children.find((child) => child.type === "/" || child.type === "+")?.type;
    if (!left || !right) return undefined;
    if (operator === "+" && left.kind === "sequence" && right.kind === "sequence") {
      return sequence([...left.items, ...right.items]);
    }
    const a = scalar(left), b = scalar(right);
    return operator && a !== undefined && b !== undefined
      ? text(operator === "/" ? (isAbsolute(b) ? b : `${a.replace(/\/$/, "")}/${b}`) : a + b) : undefined;
  }
  if (node.type === "attribute" && field(node, "attribute")?.text === "parent") {
    const base = scalar(evaluate(field(node, "object")));
    return base === undefined ? undefined : text(dirname(base));
  }
  if (node.type === "call") {
    const fn = field(node, "function")?.text;
    const params = field(node, "arguments")?.namedChildren ?? [];
    if (fn === "Path" || fn === "pathlib.Path" || fn === "str") return evaluate(params[0]);
    if (fn === "Path.home" || fn === "pathlib.Path.home") return text(homedir());
    if (fn === "Path.cwd" || fn === "pathlib.Path.cwd" || fn === "os.getcwd") return text(cwd);
    if (fn === "os.path.join" || fn === "os.path.dirname" || fn === "os.path.abspath" || fn === "os.path.realpath" ||
        fn === "os.path.normpath" || fn === "os.path.expanduser") {
      const parts = params.map((param) => scalar(evaluate(param)));
      if (!parts.length || parts.some((part) => part === undefined)) return undefined;
      const [first, ...rest] = parts as string[];
      if (fn === "os.path.join") return text(rest.reduce((joined, part) => (isAbsolute(part) ? part : `${joined.replace(/\/$/, "")}/${part}`), first));
      if (fn === "os.path.dirname") return text(dirname(first));
      if (fn === "os.path.expanduser") return text(first.replace(/^~(?=\/|$)/, homedir()));
      return text(resolve(cwd, first));
    }
    if (fn?.endsWith(".expanduser")) {
      const base = scalar(evaluate(field(field(node, "function")!, "object")));
      return base === undefined ? undefined : text(base.replace(/^~(?=\/|$)/, homedir()));
    }
    if (fn === "glob.glob" || fn === "glob.iglob") {
      const pattern = scalar(evaluate(params[0]));
      return pattern === undefined ? undefined : sequence(expand(pattern, cwd).map(text));
    }
    if (fn?.endsWith(".resolve") || fn?.endsWith(".absolute")) {
      return evaluate(field(field(node, "function")!, "object"));
    }
    const functionNode = field(node, "function");
    const receiver = functionNode && field(functionNode, "object");
    const method = functionNode && field(functionNode, "attribute")?.text;
    const mapping = evaluate(receiver);
    if (mapping?.kind === "mapping" && params.length === 0) {
      if (method === "keys") return sequence(mapping.entries.map(([key]) => key));
      if (method === "values") return sequence(mapping.entries.map(([, value]) => value));
      if (method === "items") return sequence(mapping.entries.map(([key, value]) =>
        ({ kind: "sequence", items: [key, value] })));
    }
  }
  return undefined;
}

/** Preserve tuple/key-value correspondence instead of taking Cartesian products of names. */
function bind(pattern: SyntaxNode, value: Value, env: Environment): boolean {
  if (pattern.type === "identifier") {
    env.set(pattern.text, value);
    return true;
  }
  if ((pattern.type === "pattern_list" || pattern.type === "tuple_pattern") && value.kind === "sequence" &&
      pattern.namedChildren.length === value.items.length) {
    return pattern.namedChildren.every((child, index) => bind(child, value.items[index], env));
  }
  return false;
}

/** Methods whose first argument is a file they write. */
const SAVE_METHODS = new Set(["save", "savefig", "savetxt", "savez", "savez_compressed", "to_csv", "to_json", "to_parquet",
  "to_excel", "to_pickle", "to_html", "to_feather"]);

function inspectPython(source: string, cwd: string, add: (path: string, cwd: string) => void, parser: Parser,
  script?: string): void {
  const root = parser.parse(source)?.rootNode;
  if (!root || root.hasError) return;
  // A script file knows where it lives; `Path(__file__).parent / "out.json"` is a common idiom.
  const env: Environment = new Map(script ? [["__file__", text(script)]] : []);
  const helpers = new Map<string, SyntaxNode>();
  let visits = 0;
  function visit(node: SyntaxNode, values: Environment, depth = 0): void {
    if (depth > 8 || ++visits > MAX_VISITS) return;
    if (node.type === "function_definition") {
      const name = field(node, "name")?.text;
      if (name) helpers.set(name, node);
      return;
    }
    if (node.type === "if_statement") {
      for (const child of node.namedChildren) visit(child, new Map(values), depth + 1);
      return;
    }
    if (node.type === "assignment") {
      const right = field(node, "right");
      if (right) visit(right, values, depth);
      const left = field(node, "left");
      if (left?.type === "identifier") {
        const value = evalPython(right, values, cwd);
        if (value) values.set(left.text, value);
        else values.delete(left.text);
      }
      return;
    }
    if (node.type === "for_statement") {
      const name = field(node, "left");
      const iterable = field(node, "right");
      const options = evalPython(iterable, values, cwd);
      const body = field(node, "body");
      if (options?.kind === "sequence" && body) {
        for (const option of options.items) {
          const scoped = new Map(values);
          if (!name || !bind(name, option, scoped)) continue;
          visit(body, scoped, depth);
        }
      } else if (options?.kind === "mapping" && name?.type === "identifier" && body) {
        for (const [key] of options.entries) {
          const scoped = new Map(values);
          scoped.set(name.text, key);
          visit(body, scoped, depth);
        }
      }
      return;
    }
    if (node.type === "call") {
      const fn = field(node, "function");
      const params = field(node, "arguments")?.namedChildren ?? [];
      const name = fn?.text;
      const helper = name && helpers.get(name);
      if (helper) {
        const scoped = new Map(values);
        const parameterNames = field(helper, "parameters")?.namedChildren.filter((child) => child.type === "identifier") ?? [];
        parameterNames.forEach((param, index) => {
          const value = evalPython(params[index], values, cwd);
          if (value) scoped.set(param.text, value);
        });
        const body = field(helper, "body");
        if (body) visit(body, scoped, depth + 1);
      }
      let paths: string[] | undefined;
      if ((name === "open" || name === "io.open") && /[wax+]/.test(scalar(evalPython(params[1], values, cwd)) ?? "")) {
        paths = strings(evalPython(params[0], values, cwd));
      } else if (fn?.type === "attribute") {
        const method = field(fn, "attribute")?.text;
        const receiver = field(fn, "object");
        if (method === "write_text" || method === "write_bytes" || method === "touch" || method === "unlink" || method === "mkdir") {
          paths = strings(evalPython(receiver, values, cwd));
        } else if (method && SAVE_METHODS.has(method) && params[0]?.type !== "keyword_argument") {
          // Images, figures and data frames written to a path: img.save('a.png'), df.to_csv(path).
          paths = strings(evalPython(params[0] ?? null, values, cwd));
        } else if (method === "open" && /[wax+]/.test(scalar(evalPython(params[0], values, cwd)) ?? "")) {
          paths = strings(evalPython(receiver, values, cwd));
        }
      }
      if (name && /^(?:os\.rename|os\.replace|shutil\.(?:copy|copy2|copyfile|move))$/.test(name)) {
        // A copy changes only its destination; a move also removes its source.
        const moved = /rename|replace|move/.test(name) ? strings(evalPython(params[0], values, cwd)) ?? [] : [];
        paths = [...moved, ...(strings(evalPython(params[1], values, cwd)) ?? [])];
      }
      paths?.forEach((path) => add(path, cwd));
    }
    for (const child of node.namedChildren) visit(child, values, depth);
  }
  visit(root, env);
}

function inspectJavaScript(source: string, cwd: string, add: (path: string, cwd: string) => void, parser: Parser): void {
  const root = parser.parse(source)?.rootNode;
  if (!root || root.hasError) return;
  const env = new Map<string, string>();
  function value(node: SyntaxNode | null): string | undefined {
    if (!node) return undefined;
    if (node.type === "string") return literal(node.text);
    if (node.type === "identifier") return env.get(node.text);
    if (node.type === "template_string" && !node.namedChildren.some((child) => child.type === "template_substitution")) {
      return node.text.slice(1, -1);
    }
    if (node.type === "binary_expression" && node.children.some((child) => child.type === "+")) {
      const left = value(field(node, "left"));
      const right = value(field(node, "right"));
      return left !== undefined && right !== undefined ? left + right : undefined;
    }
    if (node.type === "call_expression") {
      const fn = field(node, "function")?.text;
      if (fn === "path.join" || fn === "join" || fn === "path.resolve") {
        const parts = field(node, "arguments")?.namedChildren.map(value);
        if (parts?.length && parts.every((part) => part !== undefined)) return parts.join("/");
      }
    }
    return undefined;
  }
  function visit(node: SyntaxNode): void {
    if (node.type === "variable_declarator") {
      const name = field(node, "name");
      if (name?.type === "identifier") {
        const resolved = value(field(node, "value"));
        if (resolved !== undefined) env.set(name.text, resolved);
        else env.delete(name.text);
      }
    }
    if (node.type === "call_expression") {
      const fn = field(node, "function")?.text;
      if (fn && /^(?:(?:fs|fs\.promises)\.)?(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream)$/.test(fn)) {
        const arg = field(node, "arguments")?.namedChildren[0];
        const target = value(arg ?? null);
        if (target !== undefined) add(target, cwd);
      }
    }
    for (const child of node.namedChildren) visit(child);
  }
  visit(root);
}

/** Where agents put throwaway files. Writes there are scratch work, not edits worth a card. */
const SCRATCH = [...new Set([tmpdir(), "/tmp", "/var/tmp", "/var/folders", "/dev", "/proc", "/sys"].flatMap((dir) => {
  try { return [dir, realpathSync(dir)]; } catch { return [dir]; }
}))];

const within = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);

export function isScratch(path: string): boolean {
  return SCRATCH.some((dir) => within(path, dir));
}


/**
 * Paths never worth a card: Git internals, installed dependencies, logs, and
 * scratch files, unless the session itself works in that temp directory.
 */
export function isIgnored(path: string, cwd?: string): boolean {
  if (path.endsWith(".log") || path.split(sep).some((part) => part === ".git" || part === "node_modules")) return true;
  return isScratch(path) && !(cwd !== undefined && isScratch(cwd) && within(path, cwd));
}

export interface TargetOptions {
  /** Whether `cd` can enter a directory. Defaults to asking the filesystem. */
  directoryExists?: (path: string) => boolean;
  /** Paths never worth a card. Defaults to `isIgnored` relative to `cwd`. */
  ignored?: (path: string) => boolean;
}

/** A working directory after `cd` to something unresolvable: relative paths there are unknown. */
const UNKNOWN_CWD = "\0unknown";

const isDirectory = (path: string) => {
  try { return statSync(path).isDirectory(); } catch { return false; }
};

/** Returns only confidently resolved targets, as absolute paths. No command is executed. */
export async function extractTargets(command: string, cwd: string, options: TargetOptions = {}): Promise<string[]> {
  if (Buffer.byteLength(command) > MAX_COMMAND_BYTES) return [];
  const { bash, python, javascript } = await getParsers();
  const root = bash.parse(command)?.rootNode;
  if (!root || root.hasError) return [];
  const directoryExists = options.directoryExists ?? isDirectory;
  const ignored = options.ignored ?? ((path: string) => isIgnored(path, resolve(cwd)));
  const found = new Set<string>();
  // Scripts this command writes from heredocs (`cat > /tmp/fix.py <<EOF`), by absolute path,
  // so a later `python3 /tmp/fix.py` in the same command can be read like inline code.
  const scripts = new Map<string, string>();
  function add(path: string, cwd: string): void {
    if (!path || path.includes("\0") || found.size >= MAX_TARGETS) return;
    if (cwd === UNKNOWN_CWD && !isAbsolute(path)) return;
    const absolute = resolve(cwd, path);
    if (ignored(absolute)) return;
    found.add(absolute);
  }

  let visits = 0;
  function visit(node: SyntaxNode, initialCwd: string, env: Environment, heredoc?: string,
    depth = 0, createdDirectories = new Set<string>()): string {
    if (depth > 8 || ++visits > MAX_VISITS) return initialCwd;
    let cwd = initialCwd;
    if (node.type === "variable_assignment") {
      const name = field(node, "name")?.text;
      if (name) {
        const value = shellValue(field(node, "value"), env);
        if (value) env.set(name, value);
        else env.delete(name);
      }
      return cwd;
    }
    if (node.type === "for_statement") {
      const variable = field(node, "variable")?.text;
      const body = field(node, "body");
      const values = node.children.filter((child) => child.type === "word" || child.type === "string" || child.type === "raw_string")
        .map((child) => {
          const options = strings(shellValue(child, env));
          return child.type === "word" ? options?.flatMap((option) => expand(option, cwd)) : options;
        });
      if (variable && body && values.every((value) => value !== undefined)) {
        const options = values.flat() as string[];
        if (options.length <= MAX_TARGETS) {
          for (const option of options) {
            env.set(variable, text(option));
            cwd = visit(body, cwd, env, heredoc, depth + 1, createdDirectories);
          }
          return cwd;
        }
      }
      if (variable) env.delete(variable);
      return initialCwd;
    }
    if (node.type === "if_statement" || node.type === "case_statement") {
      // The condition is not evaluated; inspect each possible branch, but never
      // let a conditional cd/assignment relocate a later unconditional command.
      const scoped = new Map(env);
      const scopedDirs = new Set(createdDirectories);
      let branchCwd = cwd;
      for (const child of node.namedChildren) {
        if (child.type === "elif_clause" || child.type === "else_clause" || child.type === "case_item") {
          visit(child, cwd, new Map(env), heredoc, depth + 1, new Set(createdDirectories));
        } else {
          branchCwd = visit(child, branchCwd, scoped, heredoc, depth + 1, scopedDirs);
        }
      }
      return initialCwd;
    }
    if (node.type === "redirected_statement") {
      const body = field(node, "body");
      const heredocRedirect = node.namedChildren.find((child) => child.type === "heredoc_redirect");
      const content = heredocRedirect?.namedChildren.find((child) => child.type === "heredoc_body")?.text;
      if (body) cwd = visit(body, cwd, env, content, depth, createdDirectories);
      // Redirects attached to a single command open before that command runs.
      // A list's trailing redirect belongs to its final command, after earlier cds.
      const redirectCwd = body?.type === "command" ? initialCwd : cwd;
      // In `cat <<EOF > out` or `cat <<EOF | tee out`, tree-sitter nests the
      // trailing redirect or pipeline inside the heredoc redirect itself.
      const nested = heredocRedirect?.namedChildren ?? [];
      for (const child of nested) {
        if (child.type !== "file_redirect" && child.type !== "heredoc_start" && child.type !== "heredoc_body" &&
            child.type !== "heredoc_end") {
          cwd = visit(child, cwd, env, undefined, depth + 1, createdDirectories);
        }
      }
      for (const child of [...node.namedChildren, ...nested]) {
        if (child.type === "file_redirect") {
          const dest = field(child, "destination");
          // `2>&1` and `>&-` duplicate or close descriptors; they name no file.
          if (/^\d*>&/.test(child.text.trim()) && (dest?.type === "number" || dest?.text === "-")) continue;
          const paths = strings(shellValue(dest, env));
          // A redirect to several words (`> {a,b}.txt`) is an "ambiguous redirect" error in Bash.
          if (paths?.length === 1 && /^(\d*)?(?:>|>>|>\||&>|&>>)/.test(child.text.trim())) {
            paths.forEach((path) => (dest?.type === "word" ? expand(path, redirectCwd) : [path])
              .forEach((candidate) => add(candidate, redirectCwd)));
            if (content !== undefined && paths.length === 1 && /^>\|?\s*[^>]/.test(child.text.trim()) &&
                body?.type === "command" && scalar(shellValue(field(body, "name"), env)) === "cat") {
              scripts.set(resolve(redirectCwd, paths[0]), content);
            }
          }
        }
      }
      return cwd;
    }
    if (node.type === "subshell") {
      let localCwd = initialCwd;
      const local = new Map(env);
      const localDirs = new Set(createdDirectories);
      for (const child of node.namedChildren) localCwd = visit(child, localCwd, local, heredoc, depth + 1, localDirs);
      return initialCwd;
    }
    if (node.type === "pipeline") {
      const [first, ...rest] = node.namedChildren;
      if (!first) return initialCwd;
      // In "cd dir && command | next", tree-sitter groups the cd into the
      // pipeline's first child. That prefix executes in the parent shell, but
      // the piped commands themselves do not change its cwd.
      const firstBody = first.type === "redirected_statement" ? field(first, "body") : first;
      if (firstBody?.type === "list" && firstBody.namedChildren.length > 1) {
        visit(first, initialCwd, new Map(env), heredoc, depth, new Set(createdDirectories));
        let prefixCwd = initialCwd;
        for (const part of firstBody.namedChildren.slice(0, -1)) prefixCwd = visit(part, prefixCwd, env, heredoc, depth, createdDirectories);
        for (const child of rest) visit(child, prefixCwd, new Map(env), heredoc, depth, new Set(createdDirectories));
        return prefixCwd;
      }
      visit(first, initialCwd, new Map(env), heredoc, depth, new Set(createdDirectories));
      for (const child of rest) visit(child, initialCwd, new Map(env), heredoc, depth, new Set(createdDirectories));
      return initialCwd;
    }
    if (node.type === "command") {
      const name = scalar(shellValue(field(node, "name"), env));
      // Words that expand to several (brace lists, "${array[@]}") become several arguments, as in Bash.
      const args = argsOf(node).flatMap((arg): Array<string | undefined> => strings(shellValue(arg, env)) ?? [undefined]);
      if (name === "cd") {
        const operands = argsOf(node).filter((arg) => arg.text !== "--");
        if (operands.length === 0) return homedir();
        const target = operands.length === 1 ? scalar(shellValue(operands[0]!, env)) : undefined;
        if (target === undefined || target === "-") return UNKNOWN_CWD;
        if (cwd === UNKNOWN_CWD && !isAbsolute(target)) return UNKNOWN_CWD;
        const directory = resolve(cwd, target);
        // A failed cd leaves the shell where it was.
        return directoryExists(directory) || createdDirectories.has(directory) ? directory : cwd;
      }
      if (!name) return cwd;
      const executable = name.split("/").pop()!;
      if (executable === "mkdir") {
        for (const arg of args) {
          if (!arg || arg.startsWith("-")) continue;
          const directory = resolve(cwd, arg);
          createdDirectories.add(directory);
          if (args.includes("-p") || args.includes("--parents")) {
            for (let parent = dirname(directory); parent !== dirname(parent); parent = dirname(parent)) {
              createdDirectories.add(parent);
            }
          }
        }
      }
      // The program is inline (-c/-e), a script this command wrote, or read from stdin.
      const program = (inline: string[]): { source?: string; path?: string } => {
        const index = args.findIndex((arg) => arg !== undefined && inline.includes(arg));
        if (index >= 0) return { source: args[index + 1] };
        const script = args.find((arg) => arg === undefined || !arg.startsWith("-"));
        if (script === undefined && args.some((arg) => arg === undefined)) return {};
        if (!script || script === "-") return { source: heredoc };
        const path = resolve(cwd, script);
        return { source: scripts.get(path), path };
      };
      if (/^python(?:\d+(?:\.\d+)?)?$/.test(executable) && !args.includes("-m")) {
        const { source, path } = program(["-c"]);
        if (source) inspectPython(source, cwd, add, python, path);
      }
      if (executable === "node" || executable === "nodejs") {
        const { source } = program(["-e", "--eval"]);
        if (source) inspectJavaScript(source, cwd, add, javascript);
      }
      if ((executable === "bash" || executable === "sh" || executable === "zsh") && !args.includes("-c")) {
        const { source } = program([]);
        const script = source === undefined ? undefined : bash.parse(source)?.rootNode;
        if (script && !script.hasError) visit(script, cwd, new Map(), undefined, depth + 1, createdDirectories);
      }
      if (executable === "tee") {
        for (const arg of args) {
          if (!arg || arg.startsWith("-")) continue;
          add(arg, cwd);
          if (heredoc !== undefined && !args.includes("-a")) scripts.set(resolve(cwd, arg), heredoc);
        }
      }
      if (executable === "sed" && args.some((arg) => arg === "-i" || /^-[a-zA-Z]*i/.test(arg ?? "") || arg?.startsWith("--in-place"))) {
        let hasProgram = args.some((arg) => arg === "-e" || arg === "--expression" || arg === "-f" || arg === "--file" ||
          arg?.startsWith("--expression=") || arg?.startsWith("--file="));
        for (let i = 0; i < args.length; i++) {
          const arg = args[i];
          if (arg === "-e" || arg === "--expression" || arg === "-f" || arg === "--file") {
            i++; // The next argument is a sed program or a program file, not an edited file.
          } else if (arg === "-i" && args[i + 1] === "" ) {
            i++; // BSD sed -i '' takes an empty backup suffix.
          } else if (arg?.startsWith("-")) {
            continue;
          } else if (!hasProgram) {
            hasProgram = true; // Even an unresolved program occupies this position.
          } else if (arg !== undefined) {
            expand(arg, cwd).forEach((file) => add(file, cwd));
          }
        }
      }
      if ((executable === "perl" || executable === "ruby") && args.some((arg) => /^-[a-zA-Z]*i/.test(arg ?? ""))) {
        // `-e`/`-E` (possibly bundled, as in `-pe`) take the program as the next argument.
        let hasProgram = false;
        for (let i = 0; i < args.length; i++) {
          const arg = args[i];
          if (arg !== undefined && /^-[a-zA-Z.]*[eE]$/.test(arg)) {
            hasProgram = true;
            i++;
          } else if (arg?.startsWith("-")) {
            continue;
          } else if (!hasProgram) {
            hasProgram = true; // First operand is a script file.
          } else if (arg !== undefined) {
            expand(arg, cwd).forEach((file) => add(file, cwd));
          }
        }
      }
      // Direct filesystem commands: only statically named operands, never recursive directory trees.
      const moving = executable === "mv" || (executable === "git" && args[0] === "mv");
      const operands = (moving && executable === "git" ? args.slice(1) : args)
        .filter((arg) => arg && !arg.startsWith("-")) as string[];
      if (executable === "rm" && !args.some((arg) => arg === "--recursive" || /^-[a-z]*[rR]/.test(arg ?? ""))) {
        operands.forEach((operand) => expand(operand, cwd).forEach((path) => add(path, cwd)));
      }
      if (executable === "ln" && operands.length >= 2 && !args.some((arg) => arg === "-t" || arg?.startsWith("--target-directory"))) {
        const destination = operands[operands.length - 1]!;
        const noDereference = args.some((arg) => arg === "-n" || arg === "-T" || /^-[a-zA-Z]*[nT]/.test(arg ?? ""));
        const directory = destination.endsWith("/") || operands.length > 2 || (!noDereference && isDirectory(resolve(cwd, destination)));
        for (const source of operands.slice(0, -1)) add(directory ? join(destination, basename(source)) : destination, cwd);
      }
      const unsupportedLayout = args.some((arg) => arg === "-t" || arg === "--target-directory" ||
        arg?.startsWith("--target-directory=") || (executable === "cp" && (arg === "--recursive" || /^-[a-zA-Z]*[rR]/.test(arg ?? ""))));
      if ((executable === "cp" || moving) && !unsupportedLayout && operands.length >= 2) {
        const destination = operands[operands.length - 1];
        let directory = destination.endsWith("/") || operands.length > 2;
        try { directory ||= statSync(resolve(cwd, destination)).isDirectory(); } catch { /* new destination */ }
        for (const source of operands.slice(0, -1)) {
          const sources = expand(source, cwd);
          for (const file of sources) {
            if (moving) add(file, cwd);
            add(directory ? join(destination, basename(file)) : destination, cwd);
          }
        }
      }
      return cwd;
    }
    for (const child of node.namedChildren) cwd = visit(child, cwd, env, heredoc, depth, createdDirectories);
    return cwd;
  }
  visit(root, resolve(cwd), new Map([["HOME", text(homedir())]]));
  return [...found].sort();
}

/** Parses a shell command for tooling that classifies commands (see scripts/readonly.ts). */
export async function parseShell(command: string): Promise<SyntaxNode | undefined> {
  if (Buffer.byteLength(command) > MAX_COMMAND_BYTES) return undefined;
  const root = (await getParsers()).bash.parse(command)?.rootNode;
  return root && !root.hasError ? root : undefined;
}

/** The literal value of a shell word, when it has one without variables. */
export function literalWord(node: SyntaxNode): string | undefined {
  return scalar(shellValue(node, new Map()));
}
