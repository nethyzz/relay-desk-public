"""Generate the code-designed app icon; no external images or fonts."""
from pathlib import Path
from PIL import Image, ImageDraw
ROOT = Path(__file__).resolve().parents[1]
for size in (192, 512):
    scale = size / 192
    image = Image.new('RGB', (size, size), '#252d2a')
    draw = ImageDraw.Draw(image)
    def box(rect): return tuple(int(v * scale) for v in rect)
    draw.rounded_rectangle(box((0, 0, 191, 191)), radius=int(44 * scale), fill='#252d2a')
    draw.rectangle(box((43, 57, 69, 159)), fill='#f6f5f0')
    draw.rounded_rectangle(box((59, 57, 134, 121)), radius=int(25 * scale), fill='#f6f5f0')
    draw.rounded_rectangle(box((69, 80, 108, 99)), radius=int(9 * scale), fill='#252d2a')
    draw.polygon([tuple(int(v * scale) for v in p) for p in [(74, 110), (105, 110), (135, 159), (98, 159)]], fill='#f6f5f0')
    draw.ellipse(box((133, 33, 163, 63)), fill='#e48962')
    image.save(ROOT / 'public' / f'icon-{size}.png')
