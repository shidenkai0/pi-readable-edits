import { opendirSync, statSync } from "node:fs";
import { access } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
    const load = async (name: string) => {
      const parser = new Parser();
      const wasm = new URL(`../node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-${name}.wasm`, import.meta.url);
      parser.setLanguage(await Language.load(wasm.pathname));
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
  return pieces.length === 1 ? text(pieces[0]) : sequence(pieces.map(text));
}

function expand(pattern: string, cwd: string): string[] {
  if (!/[*?[\]]/.test(pattern)) return [pattern];
  if (isAbsolute(pattern)) return [];
  const directory = dirname(pattern);
  // A literal parent keeps glob work finite. Recursive or wildcard-directory
  // scans are intentionally left to ordinary Bash output.
  if (/[*?[\]{}]/.test(directory)) return [];
  let entries;
  try {
    entries = opendirSync(resolve(cwd, directory));
    let count = 0;
    while (entries.readSync()) if (++count > MAX_GLOB_ENTRIES) return [];
  } catch {
    return [];
  } finally {
    try { entries?.closeSync(); } catch { /* already closed at EOF */ }
  }
  return fg.sync(pattern, {
    cwd, dot: true, onlyFiles: true, followSymbolicLinks: false,
    ignore: ["**/.git/**", "**/node_modules/**", "**/.local/**"],
  }).slice(0, MAX_TARGETS);
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
  if (node.type === "call") {
    const fn = field(node, "function")?.text;
    const params = field(node, "arguments")?.namedChildren ?? [];
    if (fn === "Path" || fn === "pathlib.Path" || fn === "str") return evaluate(params[0]);
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

function inspectPython(source: string, cwd: string, add: (path: string, cwd: string) => void, parser: Parser): void {
  const root = parser.parse(source)?.rootNode;
  if (!root || root.hasError) return;
  const env: Environment = new Map();
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
        } else if (method === "open" && /[wax+]/.test(scalar(evalPython(params[0], values, cwd)) ?? "")) {
          paths = strings(evalPython(receiver, values, cwd));
        }
      }
      if (name && /^(?:os\.rename|os\.replace|shutil\.(?:copy|copy2|copyfile|move))$/.test(name)) {
        paths = [...(strings(evalPython(params[0], values, cwd)) ?? []), ...(strings(evalPython(params[1], values, cwd)) ?? [])];
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

/** Prefer the enclosing Git worktree, so a command started in a subdirectory can still edit siblings. */
export async function scopeRoot(cwd: string): Promise<string> {
  let dir = resolve(cwd);
  while (true) {
    try { await access(join(dir, ".git")); return dir; } catch { /* try ancestor */ }
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
}

/** Returns only confidently resolved, project-local targets. No command is executed. */
export async function extractTargets(command: string, cwd: string, projectRoot = cwd): Promise<string[]> {
  if (Buffer.byteLength(command) > MAX_COMMAND_BYTES) return [];
  const { bash, python, javascript } = await getParsers();
  const root = bash.parse(command)?.rootNode;
  if (!root || root.hasError) return [];
  const rootPath = resolve(projectRoot);
  const found = new Set<string>();
  function add(path: string, cwd: string): void {
    if (!path || path.includes("\0") || found.size >= MAX_TARGETS) return;
    const absolute = resolve(cwd, path);
    const relativePath = relative(rootPath, absolute);
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return;
    if (relativePath.split(sep).some((part) => part === ".git" || part === "node_modules" || part === ".local")) return;
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
      const content = node.namedChildren.find((child) => child.type === "heredoc_redirect")
        ?.namedChildren.find((child) => child.type === "heredoc_body")?.text;
      if (body) cwd = visit(body, cwd, env, content, depth, createdDirectories);
      // Redirects attached to a single command open before that command runs.
      // A list's trailing redirect belongs to its final command, after earlier cds.
      const redirectCwd = body?.type === "command" ? initialCwd : cwd;
      for (const child of node.namedChildren) {
        if (child.type === "file_redirect") {
          const dest = field(child, "destination");
          const paths = strings(shellValue(dest, env));
          if (paths && /^(\d*)?(?:>|>>|>\||&>|&>>)/.test(child.text.trim())) {
            paths.forEach((path) => (dest?.type === "word" ? expand(path, redirectCwd) : [path])
              .forEach((candidate) => add(candidate, redirectCwd)));
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
      const args = argsOf(node).map((arg) => scalar(shellValue(arg, env)));
      if (name === "cd") {
        if (args.length === 1 && args[0]) {
          const directory = resolve(cwd, args[0]);
          try { if (statSync(directory).isDirectory()) return directory; } catch { /* not present yet */ }
          if (createdDirectories.has(directory)) return directory;
        }
        return cwd;
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
      if (/^python(?:\d+(?:\.\d+)?)?$/.test(executable)) {
        const index = args.findIndex((arg) => arg === "-c");
        const source = index >= 0 ? args[index + 1] : heredoc;
        if (source) inspectPython(source, cwd, add, python);
      }
      if (executable === "node" || executable === "nodejs") {
        const index = args.findIndex((arg) => arg === "-e" || arg === "--eval");
        const source = index >= 0 ? args[index + 1] : heredoc;
        if (source) inspectJavaScript(source, cwd, add, javascript);
      }
      if (executable === "tee") {
        args.filter((arg) => arg && !arg.startsWith("-")).forEach((arg) => add(arg!, cwd));
      }
      if (executable === "sed" && args.some((arg) => arg === "-i" || arg?.startsWith("-i"))) {
        const rest = args.slice(args.findIndex((arg) => arg === "-i" || arg?.startsWith("-i")) + 1);
        if (rest[0] === "") rest.shift(); // BSD sed -i '' script file
        let hasProgram = false;
        for (let i = 0; i < rest.length; i++) {
          const arg = rest[i];
          if (arg === "-e" || arg === "--expression" || arg === "-f" || arg === "--file") {
            hasProgram = true;
            i++; // The next argument is a sed program or a program file, not an edited file.
          } else if (!arg || arg.startsWith("-")) {
            continue;
          } else if (!hasProgram) {
            hasProgram = true;
          } else {
            expand(arg, cwd).forEach((file) => add(file, cwd));
          }
        }
      }
      if (executable === "perl" && args.some((arg) => /^-[a-z]*i/.test(arg ?? ""))) {
        const script = args.findIndex((arg) => arg === "-e");
        const rest = script >= 0 ? args.slice(script + 2) : args.slice(2);
        rest.filter((arg) => arg && !arg.startsWith("-")).forEach((arg) => expand(arg!, cwd).forEach((file) => add(file, cwd)));
      }
      // Direct filesystem commands: only statically named operands, never recursive directory trees.
      const moving = executable === "mv" || (executable === "git" && args[0] === "mv");
      const operands = (moving && executable === "git" ? args.slice(1) : args)
        .filter((arg) => arg && !arg.startsWith("-")) as string[];
      if (executable === "rm" && !args.some((arg) => arg === "--recursive" || /^-[a-z]*[rR]/.test(arg ?? ""))) {
        operands.forEach((operand) => expand(operand, cwd).forEach((path) => add(path, cwd)));
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
  visit(root, resolve(cwd), new Map());
  return [...found].sort();
}
