# /// script
# requires-python = ">=3.11"
# dependencies = ["pyte>=0.8", "pillow>=10"]
# ///
"""Drive a real Pi TUI with a scripted model and screenshot the result.

usage: uv run scripts/demo/run.py <scenario.json> <output-prefix> [--expand] [--columns N] [--rows N]

The scenario names a fixture repository (files to create and commit) and the
model's steps. Pi runs with an isolated config directory, so personal
settings and extensions never leak into the screenshots.
"""
import argparse
import json
import os
import pty
import select
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import pyte

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from shot import render  # noqa: E402

REPO = Path(__file__).resolve().parents[2]


def fixture(scenario, root: Path):
    for path, content in scenario.get("files", {}).items():
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
    if scenario.get("git", True):
        run = lambda *args: subprocess.run(["git", *args], cwd=root, check=True, capture_output=True)
        run("init", "-q", "-b", "main")
        run("-c", "user.email=demo@example.com", "-c", "user.name=Demo", "add", "-A")
        run("-c", "user.email=demo@example.com", "-c", "user.name=Demo", "commit", "-qm", "fixture")
    for path, content in scenario.get("dirty", {}).items():
        (root / path).write_text(content)


class Terminal:
    def __init__(self, argv, cwd, env, columns, rows):
        self.screen = pyte.Screen(columns, rows)
        self.stream = pyte.ByteStream(self.screen)
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(cwd)
            os.execvpe(argv[0], argv, env)
        import fcntl, struct, termios
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))

    def pump(self, seconds):
        end = time.time() + seconds
        while time.time() < end:
            ready, _, _ = select.select([self.fd], [], [], 0.05)
            if ready:
                try:
                    data = os.read(self.fd, 65536)
                except OSError:
                    return
                if not data:
                    return
                self.stream.feed(data)

    def text(self):
        return "\n".join(self.screen.display)

    def wait_for(self, needle, timeout=30):
        end = time.time() + timeout
        while time.time() < end:
            self.pump(0.2)
            if needle in self.text():
                return True
        return False

    def send(self, data: bytes):
        os.write(self.fd, data)

    def close(self):
        try:
            os.kill(self.pid, 9)
        except ProcessLookupError:
            pass


def crop_rows(term, crop):
    if not crop:
        return None
    lines = term.screen.display
    start = next((i for i, line in enumerate(lines) if crop[0] in line), 0)
    end = next((i for i, line in enumerate(lines) if i > start and crop[1] in line), len(lines))
    return (max(0, start - 2), end - 1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("scenario")
    parser.add_argument("output")
    parser.add_argument("--expand", action="store_true")
    parser.add_argument("--columns", type=int, default=110)
    parser.add_argument("--rows", type=int, default=60)
    parser.add_argument("--theme", default="dark")
    parser.add_argument("--keep", action="store_true", help="keep the fixture directory")
    parser.add_argument("--resume", action="store_true", help="also reopen the saved session and screenshot it")
    parser.add_argument("--package", metavar="SOURCE",
                        help="pi install SOURCE into the isolated config instead of loading this checkout")
    parser.add_argument("--crop", nargs=2, metavar=("FROM", "TO"),
                        help="keep screen rows from the first line containing FROM to the one before TO")
    args = parser.parse_args()

    scenario = json.loads(Path(args.scenario).read_text())
    work = Path(tempfile.mkdtemp(prefix="readable-edits-demo-"))
    project = work / scenario.get("name", "project")
    project.mkdir()
    fixture(scenario, project)
    config = work / "agent"
    config.mkdir()
    (config / "settings.json").write_text(json.dumps({
        "theme": args.theme, "defaultProvider": "scripted", "defaultModel": "demo",
        "quietStartup": True, "collapseChangelog": True,
    }))
    script = work / "script.json"
    script.write_text(json.dumps(scenario["steps"]))

    env = {**os.environ, "PI_CODING_AGENT_DIR": str(config), "PI_OFFLINE": "1", "TERM": "xterm-256color",
           "COLORTERM": "truecolor", "READABLE_EDITS_SCRIPT": str(script)}
    sessions = work / "sessions"
    extension = [] if args.package else ["-e", str(REPO)]
    if args.package:
        subprocess.run(["pi", "install", args.package], cwd=project, env=env, check=True)
    argv = ["pi", "--session-dir", str(sessions), "--provider", "scripted", "--model", "demo",
            *extension, "-e", str(REPO / "scripts/demo/scripted-model.ts")]
    term = Terminal(argv, project, env, args.columns, args.rows)
    try:
        term.pump(4)
        term.send(scenario.get("prompt", "Make the change").encode() + b"\r")
        done = scenario.get("wait_for", "Done")
        if not term.wait_for(done, timeout=60):
            print("timed out waiting for", repr(done), file=sys.stderr)
        term.pump(1.5)
        render(term.screen, f"{args.output}.png", trim=False, rows=crop_rows(term, args.crop))
        (Path(f"{args.output}.txt")).write_text(term.text())
        if args.expand:
            term.send(b"\x0f")  # ctrl+o toggles tool output expansion
            term.pump(1.5)
            render(term.screen, f"{args.output}-expanded.png", trim=False)
            Path(f"{args.output}-expanded.txt").write_text(term.text())
        if args.resume:
            term.close()
            time.sleep(0.5)
            again = Terminal([*argv, "--continue"], project, env, args.columns, args.rows)
            try:
                again.wait_for(done, timeout=30)
                again.pump(1.5)
                render(again.screen, f"{args.output}-resumed.png", trim=False)
                Path(f"{args.output}-resumed.txt").write_text(again.text())
            finally:
                again.close()
    finally:
        term.close()
        if args.keep:
            print(project)
        else:
            shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
