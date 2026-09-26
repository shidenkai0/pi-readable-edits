/**
 * Renders representative cards with Pi's real theme and renderer, so the UI
 * can be reviewed without a model. Pipe to scripts/shot.py for a PNG:
 *
 *   FORCE_COLOR=3 COLORTERM=truecolor pnpm preview > .scratch/cards.ans && uv run scripts/shot.py .scratch/cards.ans .scratch/cards.png
 */
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { describeChanges, type RawChange } from "../src/changes.js";
import { type EditCardData, renderCard } from "../src/render.js";

const width = Number(process.env.PREVIEW_WIDTH ?? 100);
const themeName = process.env.PREVIEW_THEME ?? "dark";
initTheme(themeName, false);
// Pi renders with its global theme instance, which the package does not export.
const entry = realpathSync(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { theme } = await import(pathToFileURL(join(dirname(entry), "modes/interactive/theme/theme.js")).href) as { theme: Theme };

const cwd = "/work";
const text = (value: string) => ({ kind: "text" as const, text: value });
const absent = { kind: "absent" as const };

const app = `import { serve } from "./server";

export function start(port = 3000) {
  const server = serve({ port });
  console.log("listening on", port);
  return server;
}

export function stop(server) {
  server.close();
}
`;

function card(title: string, raw: RawChange[], extra: Partial<EditCardData> & { commands: string[] }) {
  const { files, omittedFiles } = describeChanges(raw, cwd);
  return { title, data: { v: 1 as const, files, mode: "git" as const, ...(omittedFiles ? { omittedFiles } : {}), ...extra } };
}

const lines = (n: number, label: string) => Array.from({ length: n }, (_, i) => `${label} line ${i + 1}`).join("\n") + "\n";

const samples = [
  card("sed -i on one file", [{
    path: "/work/src/app.ts", before: text(app),
    after: text(app.replace("port = 3000", "port = Number(process.env.PORT ?? 3000)").replace(`console.log("listening on", port);`, `logger.info({ port }, "listening");`)),
  }], { commands: [`sed -i '' -e 's/port = 3000/port = Number(process.env.PORT ?? 3000)/' -e 's/console.log/logger.info/' src/app.ts`] }),
  card("heredoc creating a file", [{
    path: "/work/docs/deploy.md", before: absent,
    after: text("# Deploying\n\n1. Build with `pnpm build`.\n2. Upload `dist/` to the bucket.\n3. Invalidate the CDN cache.\n"),
  }], { commands: ["cat > docs/deploy.md <<'EOF'\n# Deploying\nEOF"] }),
  card("python script touching several files", [
    { path: "/work/src/app.ts", before: text(app), after: text(app.replace("stop(server)", "stop(server: Server)")) },
    { path: "/work/src/config/defaults.ts", before: text(lines(30, "default")), after: text(lines(30, "default").replace("default line 12", "default line twelve").replace("default line 20\n", "")) },
    { path: "/work/src/legacy/old-router.ts", before: text(lines(14, "route")), after: absent },
    { path: "/work/package-lock.json", before: text(lines(80, "lock")), after: text(lines(80, "lock").replace(/lock line 4\d/g, "lock line changed")) },
    { path: "/work/.env.local", before: text("API_KEY=old\n"), after: text("API_KEY=new\nDEBUG=1\n") },
    { path: "/work/assets/logo.png", before: { kind: "binary", size: 18_220 }, after: { kind: "binary", size: 21_904 } },
    { path: "/work/src/routes/index.ts", oldPath: "/work/src/routes.ts", before: text(lines(20, "r")), after: text(lines(20, "r")) },
  ], { commands: ["python3 - <<'PY'\nimport re\nPY"] }),
  card("failed command, long lines", [{
    path: "/work/README.md", before: text("# Project\n\nThis project does a thing that is described at considerable length in this paragraph so that the line wraps in the terminal when rendered.\n"),
    after: text("# Project\n\nThis project does a thing that is described at considerable length in this paragraph so that the line wraps in the terminal when rendered, and now it mentions the new deployment guide too.\n"),
  }], { commands: ["perl -pi -e 's/rendered\\./rendered, and now it mentions the new deployment guide too./' README.md && pnpm test"], failed: true }),
];

const out: string[] = [];
for (const expanded of [false, true]) {
  for (const sample of samples) {
    out.push(theme.fg("dim", `── ${sample.title} (${expanded ? "expanded" : "collapsed"})`), "");
    out.push(...renderCard(sample.data, expanded, theme).render(width), "");
  }
}
process.stdout.write(out.join("\n") + "\n");
