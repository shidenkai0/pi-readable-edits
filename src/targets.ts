import { access } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import fg from "fast-glob";
import { Language, Parser, type Node as SyntaxNode } from "web-tree-sitter";

type Value = string[];
type Environment = Map<string, Value>;

const MAX_COMMAND_BYTES = 512_000;
const MAX_TARGETS = 128;
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

function shellWord(node: SyntaxNode): string | undefined {
  if (node.type === "raw_string") return literal(node.text);
  if (node.type === "string") {
    // Bash double quotes preserve backslashes before most characters (unlike JSON).
    const body = node.text.slice(1, -1);
    if (/(^|[^\\])[$`]/.test(body)) return undefined;
    return body.replace(/\\(["\\$`])/g, "$1").replace(/\\\n/g, "");
  }
  if (node.type !== "word" && node.type !== "command_name") return undefined;
  if (node.namedChildren.length && node.type === "word") return undefined;
  if (/[`${}\\]/.test(node.text)) return undefined;
  return node.text;
}

function expand(pattern: string, cwd: string): Value {
  if (!/[*?[\]]/.test(pattern)) return [pattern];
  if (isAbsolute(pattern)) return [];
  return fg.sync(pattern, {
    cwd, dot: true, onlyFiles: true, followSymbolicLinks: false,
    ignore: ["**/.git/**", "**/node_modules/**", "**/.local/**"],
  }).slice(0, MAX_TARGETS);
}

function argsOf(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((child) => child.type !== "command_name");
}

function sequenceExpression(node: SyntaxNode | null): boolean {
  if (!node) return false;
  if (node.type === "list" || node.type === "tuple") return true;
  if (node.type === "call") return /^(?:glob\.glob|glob\.iglob)$/.test(field(node, "function")?.text ?? "");
  if (node.type === "binary_operator" && node.children.some((child) => child.type === "+")) {
    return sequenceExpression(field(node, "left")) || sequenceExpression(field(node, "right"));
  }
  return false;
}

function evalPython(node: SyntaxNode | null, env: Environment, cwd: string): Value | undefined {
  if (!node) return undefined;
  if (node.type === "string") {
    if (node.namedChildren.some((child) => child.type === "interpolation")) {
      let result = "";
      for (const child of node.namedChildren) {
        if (child.type === "string_content") result += child.text;
        else if (child.type === "interpolation") {
          const part = evalPython(field(child, "expression"), env, cwd);
          if (part?.length !== 1) return undefined;
          result += part[0];
        }
      }
      return [result];
    }
    const value = literal(node.text);
    return value === undefined ? undefined : [value];
  }
  if (node.type === "identifier") return env.get(node.text);
  if (node.type === "parenthesized_expression") return evalPython(node.namedChildren[0], env, cwd);
  if (node.type === "list" || node.type === "tuple") {
    const items = node.namedChildren.map((item) => evalPython(item, env, cwd));
    return items.every((item) => item && item.length === 1) ? items.flatMap((item) => item!) : undefined;
  }
  if (node.type === "binary_operator") {
    const left = evalPython(field(node, "left"), env, cwd);
    const right = evalPython(field(node, "right"), env, cwd);
    const operator = node.children.find((child) => child.type === "/" || child.type === "+")?.type;
    if (!left || !right) return undefined;
    if (operator === "+" && (sequenceExpression(field(node, "left")) || sequenceExpression(field(node, "right")))) {
      return [...left, ...right].slice(0, MAX_TARGETS);
    }
    if (!operator || left.length * right.length > MAX_TARGETS) return undefined;
    return left.flatMap((a) => right.map((b) => operator === "/" ? `${a.replace(/\/$/, "")}/${b}` : a + b));
  }
  if (node.type === "call") {
    const fn = field(node, "function")?.text;
    const params = field(node, "arguments")?.namedChildren ?? [];
    if (fn === "Path" || fn === "pathlib.Path" || fn === "str") return evalPython(params[0], env, cwd);
    if (fn === "glob.glob" || fn === "glob.iglob") {
      const pattern = evalPython(params[0], env, cwd);
      return pattern?.length === 1 ? expand(pattern[0], cwd) : undefined;
    }
    if (fn?.endsWith(".resolve") || fn?.endsWith(".absolute")) {
      return evalPython(field(field(node, "function")!, "object"), env, cwd);
    }
  }
  return undefined;
}

function inspectPython(source: string, cwd: string, add: (path: string, cwd: string) => void, parser: Parser): void {
  const root = parser.parse(source)?.rootNode;
  if (!root || root.hasError) return;
  const env: Environment = new Map();
  const helpers = new Map<string, SyntaxNode>();
  function visit(node: SyntaxNode, values: Environment, depth = 0): void {
    if (depth > 8) return;
    if (node.type === "function_definition") {
      const name = field(node, "name")?.text;
      if (name) helpers.set(name, node);
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
      if (name?.type === "identifier" && options && options.length <= MAX_TARGETS && body) {
        for (const option of options) {
          const scoped = new Map(values);
          scoped.set(name.text, [option]);
          visit(body, scoped, depth);
        }
      } else if (name?.type === "pattern_list" && iterable?.type === "list" && body) {
        const names = name.namedChildren.filter((child) => child.type === "identifier");
        for (const tuple of iterable.namedChildren.slice(0, MAX_TARGETS)) {
          if (tuple.type !== "tuple" || tuple.namedChildren.length !== names.length) continue;
          const scoped = new Map(values);
          tuple.namedChildren.forEach((item, index) => {
            const value = evalPython(item, values, cwd);
            if (value) scoped.set(names[index].text, value);
          });
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
      let paths: Value | undefined;
      if ((name === "open" || name === "io.open") && /[wax+]/.test(evalPython(params[1], values, cwd)?.[0] ?? "")) {
        paths = evalPython(params[0], values, cwd);
      } else if (fn?.type === "attribute") {
        const method = field(fn, "attribute")?.text;
        const receiver = field(fn, "object");
        if (method === "write_text" || method === "write_bytes" || method === "touch" || method === "unlink" || method === "mkdir") {
          paths = evalPython(receiver, values, cwd);
        } else if (method === "open" && /[wax+]/.test(evalPython(params[0], values, cwd)?.[0] ?? "")) {
          paths = evalPython(receiver, values, cwd);
        }
      }
      if (name && /^(?:os\.rename|os\.replace|shutil\.(?:copy|copy2|copyfile|move))$/.test(name)) {
        paths = [...(evalPython(params[0], values, cwd) ?? []), ...(evalPython(params[1], values, cwd) ?? [])];
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

  function visit(node: SyntaxNode, initialCwd: string, heredoc?: string): string {
    let cwd = initialCwd;
    if (node.type === "redirected_statement") {
      const body = field(node, "body");
      const content = node.namedChildren.find((child) => child.type === "heredoc_redirect")
        ?.namedChildren.find((child) => child.type === "heredoc_body")?.text;
      if (body) cwd = visit(body, cwd, content);
      // Redirects attached to a single command open before that command runs.
      // A list's trailing redirect belongs to its final command, after earlier cds.
      const redirectCwd = body?.type === "command" ? initialCwd : cwd;
      for (const child of node.namedChildren) {
        if (child.type === "file_redirect") {
          const dest = field(child, "destination");
          const path = dest ? shellWord(dest) : undefined;
          if (path && /^(\d*)?(?:>|>>|>\||&>|&>>)/.test(child.text.trim())) {
            expand(path, redirectCwd).forEach((candidate) => add(candidate, redirectCwd));
          }
        }
      }
      return cwd;
    }
    if (node.type === "subshell") {
      let localCwd = initialCwd;
      for (const child of node.namedChildren) localCwd = visit(child, localCwd, heredoc);
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
        visit(first, initialCwd, heredoc);
        let prefixCwd = initialCwd;
        for (const part of firstBody.namedChildren.slice(0, -1)) prefixCwd = visit(part, prefixCwd, heredoc);
        for (const child of rest) visit(child, prefixCwd, heredoc);
        return prefixCwd;
      }
      visit(first, initialCwd, heredoc);
      for (const child of rest) visit(child, initialCwd, heredoc);
      return initialCwd;
    }
    if (node.type === "command") {
      const name = shellWord(field(node, "name")?.namedChildren[0] ?? field(node, "name")!);
      const args = argsOf(node).map(shellWord);
      if (name === "cd") {
        if (args.length === 1 && args[0]) return resolve(cwd, args[0]);
        return cwd;
      }
      if (!name) return cwd;
      const executable = name.split("/").pop()!;
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
      return cwd;
    }
    for (const child of node.namedChildren) cwd = visit(child, cwd, heredoc);
    return cwd;
  }
  visit(root, resolve(cwd));
  return [...found].sort();
}
