#!/usr/bin/env python3
"""Convert the large character portrait PNGs to alpha-preserving WebP.

The hero standing portraits ship as ~1.1-1.5MB 1024x1024 RGBA PNGs. Even with
prefetching, that is a lot to pull just-in-time. WebP keeps the alpha cutout while
cutting the byte size by ~10x, which is what actually removes the per-speaker load
hitch in production. Thumbnails are already WebP; this brings the portraits in line.

Usage:
    python3 scripts/optimize-portraits.py [--quality 80] [--size 1024]

Source PNGs are read from art-src/characters/ (kept out of the served bundle) and
WebP output is written to public/assets/characters/. Run from the repo root.
"""
from __future__ import annotations

import argparse
import glob
import os

from PIL import Image

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE_DIR = os.path.join(REPO_ROOT, "art-src", "characters")
OUTPUT_DIR = os.path.join(REPO_ROOT, "public", "assets", "characters")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--quality", type=int, default=80)
    parser.add_argument("--size", type=int, default=1024, help="Max edge in px (square portraits)")
    args = parser.parse_args()

    sources = sorted(glob.glob(os.path.join(SOURCE_DIR, "p*.png")))
    if not sources:
        raise SystemExit(f"No source PNGs found in {SOURCE_DIR}")

    total_in = 0
    total_out = 0
    for src in sources:
        name = os.path.splitext(os.path.basename(src))[0]
        dst = os.path.join(OUTPUT_DIR, f"{name}.webp")
        with Image.open(src) as im:
            im = im.convert("RGBA")
            if max(im.size) > args.size:
                im.thumbnail((args.size, args.size), Image.LANCZOS)
            im.save(dst, "WEBP", quality=args.quality, method=6, exact=True)
        in_kb = os.path.getsize(src) / 1024
        out_kb = os.path.getsize(dst) / 1024
        total_in += in_kb
        total_out += out_kb
        print(f"{name:18s} {in_kb:8.1f}KB -> {out_kb:7.1f}KB  ({out_kb / in_kb * 100:4.1f}%)")

    print("-" * 52)
    print(f"{'TOTAL':18s} {total_in:8.1f}KB -> {total_out:7.1f}KB  ({total_out / total_in * 100:4.1f}%)")


if __name__ == "__main__":
    main()
