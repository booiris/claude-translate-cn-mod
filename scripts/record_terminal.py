#!/usr/bin/env python3
"""Capture an existing tmux pane, preserving its actual text and ANSI colors.

Run Claude interactively in a 100x30 tmux pane before recording. This records
terminal output, not desktop pixels. No demonstration text is synthesized.
Requires tmux, ImageMagick 7, Liberation Mono and Noto Sans Mono CJK SC.
"""

import argparse
from html import escape
import json
from pathlib import Path
import re
import subprocess
import tempfile
import time
import unicodedata


ANSI = re.compile(r"\x1b\[([0-9;]*)m")
COLORS = ['#181818', '#cc6666', '#b5bd68', '#f0c674', '#81a2be', '#b294bb',
          '#8abeb7', '#c5c8c6', '#666666', '#ff7b72', '#b5e890', '#ffe090',
          '#a5c9ff', '#d5b6ff', '#a5e5ed', '#ffffff']


def palette(index):
    if index < 16:
        return COLORS[index]
    if index >= 232:
        shade = 8 + (index - 232) * 10
        return f'#{shade:02x}{shade:02x}{shade:02x}'
    value = index - 16
    steps = [0, 95, 135, 175, 215, 255]
    return '#%02x%02x%02x' % (steps[value // 36], steps[value // 6 % 6], steps[value % 6])


def svg(screen, cols=100, rows=30):
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{cols * 12 + 40}" '
             f'height="{rows * 25 + 30}">',
             '<rect width="100%" height="100%" fill="#181818"/>']
    color = '#dddddd'
    background = None
    bold = False
    dim = False
    for row, line in enumerate(screen.splitlines()[:rows]):
        column = 0
        pieces = ANSI.split(line)
        for i, piece in enumerate(pieces):
            if i % 2:
                codes = [int(n or 0) for n in piece.split(';')]
                j = 0
                while j < len(codes):
                    code = codes[j]
                    if code == 0:
                        color, background, bold, dim = '#dddddd', None, False, False
                    elif code == 39:
                        color = '#dddddd'
                    elif code == 49:
                        background = None
                    elif code == 1:
                        bold = True
                    elif code == 2:
                        dim = True
                    elif code == 22:
                        bold = dim = False
                    elif 30 <= code <= 37:
                        color = COLORS[code - 30]
                    elif 90 <= code <= 97:
                        color = COLORS[code - 90 + 8]
                    elif code == 38 and codes[j + 1:j + 2] == [5] and len(codes) > j + 2:
                        color = palette(codes[j + 2])
                        j += 2
                    elif code == 38 and codes[j + 1:j + 2] == [2] and len(codes) > j + 4:
                        color = '#%02x%02x%02x' % tuple(codes[j + 2:j + 5])
                        j += 4
                    elif code == 48 and codes[j + 1:j + 2] == [5] and len(codes) > j + 2:
                        background = palette(codes[j + 2])
                        j += 2
                    elif code == 48 and codes[j + 1:j + 2] == [2] and len(codes) > j + 4:
                        background = '#%02x%02x%02x' % tuple(codes[j + 2:j + 5])
                        j += 4
                    j += 1
                continue
            for char in piece:
                width = (0 if unicodedata.combining(char) else
                         2 if unicodedata.east_asian_width(char) in ('W', 'F') else 1)
                x, y = 20 + column * 12, 8 + row * 25
                if background:
                    parts.append(f'<rect x="{x}" y="{y}" width="{width * 12}" '
                                 f'height="25" fill="{background}"/>')
                # Block elements form Claude's mascot. Paint their cell geometry
                # directly: CJK font fallback can give these double-width glyphs.
                quadrants = {'▘': [0], '▝': [1], '▖': [2], '▗': [3],
                             '▛': [0, 1, 2], '▜': [0, 1, 3],
                             '▙': [0, 2, 3], '▟': [1, 2, 3],
                             '▀': [0, 1], '▄': [2, 3],
                             '▌': [0, 2], '▐': [1, 3], '█': [0, 1, 2, 3]}
                if char in quadrants:
                    for q in quadrants[char]:
                        parts.append(f'<rect x="{x + (q % 2) * 6}" '
                                     f'y="{y + (q // 2) * 12.5}" width="6" '
                                     f'height="12.5" fill="{color}"/>')
                elif not char.isspace():
                    font = 'Noto Sans Mono CJK SC' if width == 2 else 'Liberation Mono'
                    parts.append(f'<text x="{x + (2 if width == 2 else 0)}" y="{y + 20}" '
                                 f'fill="{color}" font-family="{font}" '
                                 f'font-weight="{700 if bold else 400}" '
                                 f'opacity="{0.6 if dim else 1}" '
                                 f'font-size="20">{escape(char)}</text>')
                column += width
    parts.append('</svg>')
    return '\n'.join(parts)


def remove_redraw_frames(frames):
    """Drop isolated partial redraws only when neighboring frames restore text."""
    plain = [ANSI.sub('', item['screen']) for item in frames]
    kept = []
    for i, item in enumerate(frames):
        if 0 < i < len(frames) - 1:
            previous, current, following = plain[i - 1:i + 2]
            shared = {line.strip() for line in previous.splitlines() if len(line.strip()) >= 20}
            shared &= {line.strip() for line in following.splitlines()}
            missing = shared - {line.strip() for line in current.splitlines()}
            if (missing and len(current.strip()) < 0.85 * min(len(previous.strip()), len(following.strip()))
                    and frames[i + 1]['time'] - item['time'] < 1):
                continue
        kept.append(item)
    return kept


def shorten_translation_waits(frames):
    """Keep a few real frames per translation wait, totaling about one second."""
    result = []
    index = 0
    while index < len(frames):
        match = re.search(r'正在将(?:输入翻译为英文|最终回复翻译为中文)', frames[index]['screen'])
        if not match:
            result.append(frames[index])
            index += 1
            continue
        end = index + 1
        while end < len(frames) and match.group() in frames[end]['screen']:
            end += 1
        count = end - index
        selected = sorted({index + round(i * (count - 1) / 3) for i in range(4)})
        result.extend({**frames[i], 'delay': 25} for i in selected)
        index = end
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--socket', help='tmux socket; required when capturing.')
    parser.add_argument('--replay', action='store_true', help='Render existing frames.json without recording again.')
    parser.add_argument('--target', default='recording')
    parser.add_argument('--seconds', type=float, default=120)
    parser.add_argument('--output', type=Path, default=Path('docs/demo.gif'))
    parser.add_argument('--capture-dir', type=Path, required=True,
                        help='Private directory for raw screen captures; review before sharing.')
    args = parser.parse_args()
    args.capture_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    if args.replay:
        frames = json.loads((args.capture_dir / 'frames.json').read_text())
        elapsed = frames[-1]['time']
    else:
        if not args.socket:
            parser.error('--socket is required unless --replay is used')
        frames = []
        started = time.monotonic()
        while time.monotonic() - started < args.seconds:
            screen = subprocess.check_output(['tmux', '-S', args.socket, 'capture-pane',
                                              '-e', '-p', '-t', args.target], text=True)
            now = time.monotonic() - started
            if not frames or screen != frames[-1]['screen']:
                frames.append({'time': round(now, 3), 'screen': screen})
            (args.capture_dir / 'frames.json').write_text(json.dumps(frames, ensure_ascii=False))
            # A caller can end capture after a completed response without losing frames.
            if (args.capture_dir / 'stop').exists():
                break
            time.sleep(0.6)
        elapsed = time.monotonic() - started
        print(f'Captured {len(frames)} real terminal frames over {elapsed:.1f}s.', flush=True)
    stable = remove_redraw_frames(frames)
    print(f'Removed {len(frames) - len(stable)} transient redraw frame(s).', flush=True)
    frames = shorten_translation_waits(stable)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='claude-recording-render-') as tmp:
        command = ['magick']
        for i, item in enumerate(frames):
            source = Path(tmp) / f'{i:04}.svg'
            image = source.with_suffix('.png')
            source.write_text(svg(item['screen']))
            subprocess.run(['magick', str(source), str(image)], check=True)
            next_time = frames[i + 1]['time'] if i + 1 < len(frames) else elapsed + 3
            # Compress waits after removing isolated partial redraws.
            delay = item.get('delay', max(10, min(200, round((next_time - item['time']) * 100))))
            if i == len(frames) - 1:
                delay = 400
            command.extend(['-delay', str(delay), str(image)])
        command.extend(['-loop', '0', '-layers', 'Optimize', str(args.output)])
        subprocess.run(command, check=True)
    print(f'Saved {args.output} ({args.output.stat().st_size:,} bytes)', flush=True)


if __name__ == '__main__':
    main()
