"""Draws icon-192.png / icon-512.png (same design as icon.svg). Run once with footage-venv python."""
from pathlib import Path
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
BARS = [(86, 206, 100), (134, 146, 220), (182, 186, 140), (302, 166, 180), (350, 126, 260), (398, 196, 120)]

for size in (192, 512):
    k = size / 512
    big = Image.new("RGBA", (512 * 2, 512 * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    s = 2
    d.rounded_rectangle([0, 0, 512 * s - 1, 512 * s - 1], radius=112 * s, fill="#111214")
    for x, y, h in BARS:
        d.rounded_rectangle([x * s, y * s, (x + 28) * s, (y + h) * s], radius=14 * s, fill="#7fd3ae")
    d.rounded_rectangle([236 * s, 246 * s, 276 * s, 266 * s], radius=10 * s, fill="#a2524f")
    for y in range(96, 417, 36):
        d.ellipse([(256 - 7) * s, (y - 7) * s, (256 + 7) * s, (y + 7) * s], fill="#f2c14e")
    big.resize((size, size), Image.LANCZOS).save(HERE / f"icon-{size}.png")
    print("wrote", f"icon-{size}.png")
