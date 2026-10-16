#!/usr/bin/env python3
"""Generate all favicon and PWA icons for public/ from public/images/logo.png.

Generates:
  - favicon.ico (multi-frame 16x16, 32x32, 48x48)
  - favicon-16x16.png (16x16)
  - favicon-32x32.png (32x32)
  - favicon-48x48.png (48x48)
  - apple-touch-icon.png (180x180)
  - apple-touch-icon-precomposed.png (180x180)
  - android-chrome-192x192.png (192x192)
  - android-chrome-512x512.png (512x512)
  - android-chrome-maskable-192x192.png (192x192 maskable with safe zone)
  - android-chrome-maskable-512x512.png (512x512 maskable with safe zone)
  - favicon-192x192.png (192x192)
  - favicon-512x512.png (512x512)
"""

import os
import subprocess
import sys
from pathlib import Path
import numpy as np

try:
    from PIL import Image, ImageDraw
except ImportError:
    sys.exit("Error: Pillow is required. Install via: pip install pillow")

ROOT = Path(__file__).resolve().parent.parent
PUBLIC_DIR = ROOT / "public"
LOGO_SRC = PUBLIC_DIR / "images" / "logo.png"

# Brand theme color matching site.webmanifest
THEME_BG = (18, 18, 28, 255)  # #12121c


def make_maskable_icon(logo_img: Image.Image, size: int) -> Image.Image:
    """Create a PWA maskable icon with the central 80% safe area and smooth edge blend."""
    safe_size = int(size * 0.8)
    offset = (size - safe_size) // 2
    canvas = Image.new("RGBA", (size, size), THEME_BG)

    logo_scaled = logo_img.resize((safe_size, safe_size), Image.Resampling.LANCZOS)

    # Soft edge feathering so logo background smoothly merges with theme background
    feather_px = max(4, int(safe_size * 0.04))
    alpha_mask = Image.new("L", (safe_size, safe_size), 255)
    draw = ImageDraw.Draw(alpha_mask)
    for i in range(feather_px):
        alpha = int(255 * (i / float(feather_px)))
        draw.rectangle([i, i, safe_size - 1 - i, safe_size - 1 - i], outline=alpha)

    # Multiply scaled logo's alpha by feather mask
    scaled_r, scaled_g, scaled_b, scaled_a = logo_scaled.split()
    combined_a = (np.array(scaled_a, dtype=float) * np.array(alpha_mask, dtype=float) / 255.0).astype(np.uint8)
    logo_scaled.putalpha(Image.fromarray(combined_a))

    canvas.alpha_composite(logo_scaled, (offset, offset))
    return canvas


def main():
    if not LOGO_SRC.exists():
        sys.exit(f"Error: Source logo not found at {LOGO_SRC}")

    print(f"Loading master logo: {LOGO_SRC}")
    logo = Image.open(LOGO_SRC).convert("RGBA")
    print(f"Master logo format: RGBA, size: {logo.size}")

    # Base image composited over THEME_BG for crisp opaque icons
    base_opaque = Image.new("RGBA", logo.size, THEME_BG)
    base_opaque.alpha_composite(logo)

    # Standard icons
    standard_icons = [
        ("favicon-16x16.png", (16, 16), "RGB"),
        ("favicon-32x32.png", (32, 32), "RGB"),
        ("favicon-48x48.png", (48, 48), "RGB"),
        ("apple-touch-icon.png", (180, 180), "RGB"),
        ("apple-touch-icon-precomposed.png", (180, 180), "RGB"),
        ("android-chrome-192x192.png", (192, 192), "RGB"),
        ("android-chrome-512x512.png", (512, 512), "RGB"),
        ("favicon-192x192.png", (192, 192), "RGB"),
        ("favicon-512x512.png", (512, 512), "RGB"),
    ]

    for filename, dims, mode in standard_icons:
        dest_path = PUBLIC_DIR / filename
        resized = base_opaque.resize(dims, Image.Resampling.LANCZOS)
        if mode == "RGB":
            resized = resized.convert("RGB")
        resized.save(dest_path, "PNG", optimize=True)
        print(f"  ✓ Created {filename} ({dims[0]}x{dims[1]}, {mode}, {dest_path.stat().st_size:,} bytes)")

    # Maskable PWA icons
    maskable_icons = [
        ("android-chrome-maskable-192x192.png", 192),
        ("android-chrome-maskable-512x512.png", 512),
    ]

    for filename, size in maskable_icons:
        dest_path = PUBLIC_DIR / filename
        maskable = make_maskable_icon(logo, size)
        maskable.save(dest_path, "PNG", optimize=True)
        print(f"  ✓ Created {filename} ({size}x{size}, RGBA maskable, {dest_path.stat().st_size:,} bytes)")

    # Generate multi-resolution favicon.ico containing 16x16, 32x32, 48x48
    ico_dest = PUBLIC_DIR / "favicon.ico"
    f16 = PUBLIC_DIR / "favicon-16x16.png"
    f32 = PUBLIC_DIR / "favicon-32x32.png"
    f48 = PUBLIC_DIR / "favicon-48x48.png"

    magick_path = subprocess.run(["which", "magick"], capture_output=True, text=True).stdout.strip()
    if magick_path:
        cmd = [magick_path, str(f16), str(f32), str(f48), str(ico_dest)]
        subprocess.run(cmd, check=True)
        print(f"  ✓ Created favicon.ico with ImageMagick (16x16, 32x32, 48x48, {ico_dest.stat().st_size:,} bytes)")
    else:
        ico_img = base_opaque.resize((48, 48), Image.Resampling.LANCZOS)
        ico_img.save(ico_dest, format="ICO", sizes=[(16, 16), (32, 32), (48, 48)])
        print(f"  ✓ Created favicon.ico with Pillow ({ico_dest.stat().st_size:,} bytes)")

    print("\nAll public icons generated successfully!")


if __name__ == "__main__":
    main()
