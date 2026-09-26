# /// script
# requires-python = ">=3.11"
# dependencies = ["pyte>=0.8", "pillow>=10"]
# ///
"""Render ANSI terminal output to a PNG, so UI changes can be reviewed as images.

usage: uv run scripts/shot.py <input.ans> <output.png> [columns] [rows]
"""
import sys

import pyte
from PIL import Image, ImageDraw, ImageFont

BASE16 = {
    "black": (0, 0, 0), "red": (205, 49, 49), "green": (13, 188, 121), "brown": (229, 229, 16),
    "yellow": (229, 229, 16), "blue": (36, 114, 200), "magenta": (188, 63, 188), "cyan": (17, 168, 205),
    "white": (229, 229, 229), "brightblack": (102, 102, 102), "brightred": (241, 76, 76),
    "brightgreen": (35, 209, 139), "brightyellow": (245, 245, 67), "brightblue": (59, 142, 234),
    "brightmagenta": (214, 112, 214), "brightcyan": (41, 184, 219), "brightwhite": (255, 255, 255),
}
BACKGROUND = (24, 24, 27)
FOREGROUND = (212, 212, 216)


def color(value, default):
    if value in (None, "default"):
        return default
    if value in BASE16:
        return BASE16[value]
    if len(value) == 6:
        try:
            return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))
        except ValueError:
            return default
    return default


def load_font(size):
    for path in ("/System/Library/Fonts/Menlo.ttc", "/System/Library/Fonts/SFNSMono.ttf",
                 "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"):
        try:
            return ImageFont.truetype(path, size), ImageFont.truetype(path, size, index=1)
        except OSError:
            continue
    font = ImageFont.load_default()
    return font, font


def render(screen, output, trim=True, rows=None):
    """Draw the screen; `rows` optionally selects a (first, last) range of lines."""
    font, bold = load_font(15)
    cell_w = round(font.getlength("M"))
    cell_h = 21
    first, last = rows if rows else (0, screen.lines)
    rows = last - first
    if trim and not first:
        used = [y for y in range(screen.lines) if any(screen.buffer[y][x].data.strip() or screen.buffer[y][x].bg != "default" for x in range(screen.columns))]
        rows = (max(used) + 2) if used else 1
    image = Image.new("RGB", (screen.columns * cell_w + 24, rows * cell_h + 24), BACKGROUND)
    draw = ImageDraw.Draw(image)
    for y in range(rows):
        line = screen.buffer[first + y]
        for x in range(screen.columns):
            char = line[x]
            fg, bg = color(char.fg, FOREGROUND), color(char.bg, BACKGROUND)
            if char.reverse:
                fg, bg = bg, fg
            left, top = 12 + x * cell_w, 12 + y * cell_h
            if bg != BACKGROUND:
                draw.rectangle([left, top, left + cell_w, top + cell_h], fill=bg)
            if char.data.strip():
                draw.text((left, top + 2), char.data, font=bold if char.bold else font, fill=fg)
            if char.underscore:
                draw.line([left, top + cell_h - 3, left + cell_w, top + cell_h - 3], fill=fg)
    image.save(output)


def main():
    source, output = sys.argv[1], sys.argv[2]
    columns = int(sys.argv[3]) if len(sys.argv) > 3 else 100
    rows = int(sys.argv[4]) if len(sys.argv) > 4 else 200
    screen = pyte.Screen(columns, rows)
    stream = pyte.ByteStream(screen)
    data = open(source, "rb").read().replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
    stream.feed(data)
    render(screen, output)


if __name__ == "__main__":
    main()
