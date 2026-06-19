#!/usr/bin/env python3
"""Create a transparent animated GIF using one stable canonical silhouette."""

import argparse
import json
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

STICKER_OUTLINE_PX = 5


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--canonical-frame", type=int, default=0)
    parser.add_argument("--alpha-threshold", type=int, default=178)
    parser.add_argument(
        "--outline",
        type=int,
        default=STICKER_OUTLINE_PX,
        help="Deprecated; the primary sticker outline is always 5px.",
    )
    parser.add_argument("--padding", type=int, default=24)
    parser.add_argument("--restore-polygons", type=Path)
    parser.add_argument("--restore-mask", type=Path)
    parser.add_argument(
        "--cut-mask",
        type=Path,
        help="Use this mask as the complete stable cut boundary instead of rembg alpha.",
    )
    return parser.parse_args()


def odd_size(radius):
    return max(3, radius * 2 + 1)


def polygon_mask(size, polygons):
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    for polygon in polygons:
        draw.polygon([tuple(point) for point in polygon], fill=255)
    return mask


def load_config(path):
    if not path:
        return {}
    return json.loads(path.read_text())


def main():
    args = parse_args()
    config = load_config(args.restore_polygons)
    source = Image.open(args.input)
    source.seek(args.canonical_frame)
    canonical = source.convert("RGBA")

    if args.cut_mask:
        alpha = Image.open(args.cut_mask).convert("L")
        if alpha.size != canonical.size:
            alpha = alpha.resize(canonical.size, Image.Resampling.NEAREST)
        alpha = alpha.point(lambda value: 255 if value >= 128 else 0)
    else:
        from rembg import new_session, remove

        session = new_session("u2net")
        removed = remove(canonical, session=session)
        alpha = removed.getchannel("A").point(
            lambda value: 255 if value >= args.alpha_threshold else 0
        )

    restore_polygons = config.get("restore_polygons", [])
    if restore_polygons:
        alpha = ImageChops.lighter(
            alpha, polygon_mask(canonical.size, restore_polygons)
        )
    if args.restore_mask:
        restore_mask = Image.open(args.restore_mask).convert("L")
        if restore_mask.size != canonical.size:
            restore_mask = restore_mask.resize(canonical.size, Image.Resampling.NEAREST)
        alpha = ImageChops.lighter(alpha, restore_mask)

    outline_alpha = alpha.filter(ImageFilter.MaxFilter(odd_size(STICKER_OUTLINE_PX)))
    bright_layers = []
    for item in config.get("preserve_bright_rects", []):
        box = tuple(item["box"])
        threshold = item.get("threshold", 205)
        mask = Image.new("L", canonical.size, 0)
        bright = canonical.convert("L").point(
            lambda value: 255 if value > threshold else 0
        )
        mask.paste(bright.crop(box), box[:2])
        stroke = mask.filter(ImageFilter.MaxFilter(odd_size(item.get("stroke", 5))))
        outline = stroke.filter(
            ImageFilter.MaxFilter(odd_size(item.get("outline", 7)))
        )
        bright_layers.append((mask, stroke, outline))

    canvas_size = (
        canonical.width + args.padding * 2,
        canonical.height + args.padding * 2,
    )
    offset = (args.padding, args.padding)
    frames = []
    durations = []

    for index in range(source.n_frames):
        source.seek(index)
        original = source.convert("RGBA")
        subject = original.copy()
        subject.putalpha(alpha)
        canvas = Image.new("RGBA", canvas_size, (0, 0, 0, 0))

        white = Image.new("RGBA", canonical.size, (255, 255, 255, 255))
        transparent = Image.new("RGBA", canonical.size, (0, 0, 0, 0))
        canvas.alpha_composite(
            Image.composite(white, transparent, outline_alpha), offset
        )
        canvas.alpha_composite(subject, offset)

        for mask, stroke, outline in bright_layers:
            canvas.alpha_composite(
                Image.composite(white, transparent, outline), offset
            )
            black = Image.new("RGBA", canonical.size, (8, 8, 8, 255))
            canvas.alpha_composite(
                Image.composite(black, transparent, stroke), offset
            )
            canvas.alpha_composite(
                Image.composite(white, transparent, mask), offset
            )

        frames.append(canvas)
        durations.append(source.info.get("duration", 100))

    args.output.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(
        args.output,
        save_all=True,
        append_images=frames[1:],
        duration=durations,
        loop=0,
        disposal=2,
        optimize=False,
    )
    print(f"Wrote {len(frames)} frames to {args.output}")


if __name__ == "__main__":
    main()
