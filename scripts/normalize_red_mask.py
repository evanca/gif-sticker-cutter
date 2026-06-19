#!/usr/bin/env python3
"""Normalize a red marker guide into a smooth inner-edge cut mask."""

import argparse
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage as ndi

STICKER_OUTLINE_PX = 5


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--overlay", type=Path, required=True)
    parser.add_argument("--output-cut-mask", type=Path, required=True)
    parser.add_argument("--output-preview", type=Path, required=True)
    parser.add_argument("--preview-frame", type=Path)
    parser.add_argument("--red-grow", type=int, default=5)
    parser.add_argument("--close-radius", type=int, default=10)
    parser.add_argument("--open-radius", type=int, default=5)
    parser.add_argument("--sigma", type=float, default=7.0)
    parser.add_argument("--threshold", type=float, default=0.50)
    return parser.parse_args()


def disk(radius):
    yy, xx = np.ogrid[-radius : radius + 1, -radius : radius + 1]
    return (xx * xx + yy * yy) <= radius * radius


def odd_size(radius):
    return max(3, radius * 2 + 1)


def red_mask(overlay):
    pixels = np.array(overlay)
    return (
        (pixels[..., 0] > 180)
        & (pixels[..., 1] < 100)
        & (pixels[..., 2] < 100)
        & (pixels[..., 3] > 0)
    )


def fill_inside(red_np):
    h, w = red_np.shape
    boundary = Image.fromarray(
        (ndi.binary_dilation(red_np, structure=disk(1)) * 255).astype("uint8"),
        "L",
    )
    outside = boundary.copy()
    for corner in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        if outside.getpixel(corner) == 0:
            ImageDraw.floodfill(outside, corner, 128, thresh=0)
    return np.array(outside) != 128


def build_preview(frame, red, final_outer, output):
    w, h = final_outer.size
    preview = Image.new("RGBA", (w, h), (36, 36, 36, 255))
    draw = ImageDraw.Draw(preview)
    for y in range(0, h, 20):
        for x in range(0, w, 20):
            color = (42, 42, 42, 255) if (x // 20 + y // 20) % 2 == 0 else (54, 54, 54, 255)
            draw.rectangle([x, y, x + 19, y + 19], fill=color)

    if frame:
        source_frame = Image.open(frame).convert("RGBA").resize((w, h))
        masked_frame = Image.composite(
            source_frame,
            Image.new("RGBA", (w, h), (0, 0, 0, 0)),
            final_outer,
        )
        preview.alpha_composite(masked_frame)

    cyan = Image.new("RGBA", (w, h), (0, 220, 255, 145))
    edge = final_outer.filter(ImageFilter.FIND_EDGES).filter(ImageFilter.MaxFilter(5))
    preview.alpha_composite(Image.composite(cyan, Image.new("RGBA", (w, h), (0, 0, 0, 0)), edge))
    red_overlay = Image.new("RGBA", (w, h), (255, 36, 36, 235))
    preview.alpha_composite(Image.composite(red_overlay, Image.new("RGBA", (w, h), (0, 0, 0, 0)), red))
    preview.save(output)


def main():
    args = parse_args()
    overlay = Image.open(args.overlay).convert("RGBA")
    red_np = red_mask(overlay)
    filled = fill_inside(red_np)

    red_exclusion = ndi.binary_dilation(red_np, structure=disk(args.red_grow))
    inner = filled & ~red_exclusion
    smoothed = ndi.binary_closing(inner, structure=disk(args.close_radius))
    smoothed = ndi.binary_opening(smoothed, structure=disk(args.open_radius))
    soft = ndi.gaussian_filter(smoothed.astype("float32"), sigma=args.sigma)
    allowed = soft >= args.threshold
    allowed &= ndi.binary_dilation(inner, structure=disk(3))
    allowed = ndi.binary_fill_holes(allowed)

    allowed_image = Image.fromarray((allowed * 255).astype("uint8"), "L")
    cut_mask = allowed_image.filter(ImageFilter.MinFilter(odd_size(STICKER_OUTLINE_PX)))
    final_outer = cut_mask.filter(ImageFilter.MaxFilter(odd_size(STICKER_OUTLINE_PX)))

    args.output_cut_mask.parent.mkdir(parents=True, exist_ok=True)
    cut_mask.save(args.output_cut_mask)
    build_preview(
        args.preview_frame,
        Image.fromarray((red_np * 255).astype("uint8"), "L"),
        final_outer,
        args.output_preview,
    )
    print(f"cut_mask={args.output_cut_mask}")
    print(f"preview={args.output_preview}")


if __name__ == "__main__":
    main()
