"""Generate the Android launcher rasters from the book-and-spark app icon."""
from pathlib import Path
from math import hypot
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
RES = ROOT / 'android/app/src/main/res'


def icon(size, foreground=False, circle=False):
    canvas = Image.new('RGBA', (size, size))
    if not foreground:
        pixels = canvas.load()
        for y in range(size):
            for x in range(size):
                blend = (x + y) / (2 * size)
                glow = max(0, 1 - hypot(x / size - .15, y / size - .12) / .85) * .22
                base = [round(a + (b - a) * blend) for a, b in zip((102, 142, 255), (43, 65, 201))]
                pixels[x, y] = tuple(round(c + (255 - c) * glow) for c in base) + (255,)
        mask = Image.new('L', (size, size))
        draw = ImageDraw.Draw(mask)
        if circle:
            draw.ellipse((0, 0, size - 1, size - 1), fill=255)
        else:
            draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=size * .23, fill=255)
        canvas.putalpha(mask)
    overlay = Image.new('RGBA', (size, size))
    draw = ImageDraw.Draw(overlay)
    scale = size / 108
    points = lambda values: [(round(x * scale), round(y * scale)) for x, y in values]
    stroke = max(1, round(2.8 * scale))
    left = [(29, 40), (39, 39), (47, 42), (54, 47), (54, 72), (46, 67), (38, 65), (29, 66), (29, 40)]
    right = [(54, 47), (61, 42), (69, 39), (79, 40), (79, 66), (70, 65), (62, 67), (54, 72)]
    draw.polygon(points(left), fill=(255, 255, 255, 48))
    draw.polygon(points(right), fill=(255, 255, 255, 80))
    draw.line(points(left), fill='white', width=stroke, joint='curve')
    draw.line(points(right), fill='white', width=stroke, joint='curve')
    for line in [[(36, 48), (46, 51)], [(36, 56), (46, 59)], [(62, 52), (71, 49)], [(62, 60), (71, 57)]]:
        draw.line(points(line), fill=(255, 255, 255, 190), width=max(1, round(1.6 * scale)))
    draw.polygon(points([(76, 26), (79, 33), (86, 36), (79, 39), (76, 46), (73, 39), (66, 36), (73, 33)]), fill='white')
    return Image.alpha_composite(canvas, overlay)


for density, factor in {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}.items():
    folder = RES / f'mipmap-{density}'
    folder.mkdir(exist_ok=True)
    for filename, size, foreground, circle in [
        ('ic_launcher.png', round(48 * factor), False, False),
        ('ic_launcher_round.png', round(48 * factor), False, True),
        ('ic_launcher_foreground.png', round(108 * factor), True, False),
    ]:
        icon(size * 3, foreground, circle).resize((size, size), Image.Resampling.LANCZOS).save(folder / filename)

preview = ROOT / 'docs/qa/android-browser/app-icon.png'
preview.parent.mkdir(parents=True, exist_ok=True)
icon(512).save(preview)
print(f'Generated launcher icons and {preview}')
