"""Generate Next/Image-style responsive variants for local posters.
Originals are 1.5-14MB (up to 8298px wide). We emit small immutable
derivatives the frontend loads via <picture> + srcset:

  opt/<stem>-640.webp   (card mobile)
  opt/<stem>-1024.webp  (card desktop / default)
  opt/<stem>-1600.webp  (lightbox full)
  opt/<stem>-1024.jpg   (fallback for no-webp browsers)

Skips outputs newer than the source. Run: python3 tools/optimize_images.py
"""
import os
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit("PIL missing: pip install pillow")

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "public" / "images" / "posters"
DST = SRC / "opt"
WIDTHS_WEBP = [(640, 72), (1024, 70), (1600, 68)]

DST.mkdir(parents=True, exist_ok=True)

files = sorted([p for p in SRC.glob("*.jpg") if p.is_file()])
if not files:
    print("no source jpgs found")
    sys.exit(0)

total_in, total_out = 0, 0
for src in files:
    stem = src.stem
    try:
        im = Image.open(src)
        im = im.convert("RGB")
    except Exception as e:
        print(f"SKIP {src.name}: {e}")
        continue
    ow, oh = im.size
    total_in += src.stat().st_size
    for w, q in WIDTHS_WEBP:
        if ow <= w and w != min(x[0] for x in WIDTHS_WEBP):
            # don't upscale beyond original except smallest bucket
            pass
        out = DST / f"{stem}-{w}.webp"
        if out.exists() and out.stat().st_mtime >= src.stat().st_mtime:
            total_out += out.stat().st_size
            continue
        h = round(oh * w / ow)
        small = im.resize((w, h), Image.LANCZOS) if ow > w else im
        small.save(out, "WEBP", quality=q, method=6)
        total_out += out.stat().st_size
        print(f"{src.name} -> {out.name} {w}x{h} {out.stat().st_size // 1024}KB")
    # jpg fallback at 1024
    out_j = DST / f"{stem}-1024.jpg"
    if not (out_j.exists() and out_j.stat().st_mtime >= src.stat().st_mtime):
        w = 1024
        h = round(oh * w / ow)
        small = im.resize((w, h), Image.LANCZOS) if ow > w else im
        small.save(out_j, "JPEG", quality=72, optimize=True, progressive=True)
        print(f"{src.name} -> {out_j.name} {out_j.stat().st_size // 1024}KB")
    total_out += out_j.stat().st_size if out_j.exists() else 0

print(f"\noriginals: {total_in / 1e6:.1f}MB  derivatives: {total_out / 1e6:.1f}MB")
