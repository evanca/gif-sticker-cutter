#!/usr/bin/env python3
"""Audit animated cutout silhouette consistency and create a contact sheet."""

import argparse
import hashlib
from pathlib import Path

from PIL import Image, ImageColor, ImageDraw


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("--background", default="#dfff00")
    parser.add_argument("--contact-sheet", type=Path)
    return parser.parse_args()


def main():
    args = parse_args()
    gif = Image.open(args.input)
    frames = []
    records = []

    for index in range(gif.n_frames):
        gif.seek(index)
        frame = gif.convert("RGBA")
        alpha = frame.getchannel("A")
        records.append(
            {
                "index": index,
                "size": frame.size,
                "bbox": alpha.getbbox(),
                "hash": hashlib.sha256(alpha.tobytes()).hexdigest()[:12],
            }
        )
        background = Image.new("RGBA", frame.size, ImageColor.getrgb(args.background))
        background.alpha_composite(frame)
        frames.append(background.convert("RGB"))

    reference = records[0]
    stable = all(
        record["size"] == reference["size"]
        and record["bbox"] == reference["bbox"]
        and record["hash"] == reference["hash"]
        for record in records
    )

    for record in records:
        print(
            f"frame={record['index']} size={record['size']} "
            f"bbox={record['bbox']} alpha={record['hash']}"
        )
    print(f"stable_silhouette={str(stable).lower()}")

    thumb_size = (240, 240)
    columns = min(4, len(frames))
    rows = (len(frames) + columns - 1) // columns
    sheet = Image.new("RGB", (columns * 260, rows * 280), "white")
    draw = ImageDraw.Draw(sheet)
    for index, frame in enumerate(frames):
        frame.thumbnail(thumb_size)
        x = (index % columns) * 260 + 10
        y = (index // columns) * 280 + 10
        sheet.paste(frame, (x, y))
        draw.text((x, y + 245), f"frame {index}", fill="black")

    output = args.contact_sheet or args.input.with_name(
        f"{args.input.stem}-contact-sheet.png"
    )
    sheet.save(output)
    print(f"contact_sheet={output}")
    raise SystemExit(0 if stable else 1)


if __name__ == "__main__":
    main()
