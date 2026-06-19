#!/usr/bin/env python3
"""Extract one GIF frame as a PNG."""

import argparse
from pathlib import Path

from PIL import Image


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--frame", type=int, default=0)
    args = parser.parse_args()

    gif = Image.open(args.input)
    gif.seek(args.frame)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    gif.convert("RGBA").save(args.output)
    print(f"frame={args.frame}")
    print(f"output={args.output}")


if __name__ == "__main__":
    main()
