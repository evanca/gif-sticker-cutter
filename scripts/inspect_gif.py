#!/usr/bin/env python3
"""Validate GIF dimensions and frame count before expensive processing."""

import argparse
from pathlib import Path

from PIL import Image


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("--max-frames", type=int, default=160)
    parser.add_argument("--max-dimension", type=int, default=1200)
    parser.add_argument("--max-pixels", type=int, default=1200 * 1200)
    args = parser.parse_args()

    gif = Image.open(args.input)
    width, height = gif.size
    frames = getattr(gif, "n_frames", 1)

    if width > args.max_dimension or height > args.max_dimension:
        raise SystemExit(f"GIF dimensions exceed limit: {width}x{height}")
    if width * height > args.max_pixels:
        raise SystemExit(f"GIF pixel area exceeds limit: {width * height}")
    if frames > args.max_frames:
        raise SystemExit(f"GIF frame count exceeds limit: {frames}")

    print(f"gif_size={width}x{height}")
    print(f"gif_frames={frames}")


if __name__ == "__main__":
    main()
