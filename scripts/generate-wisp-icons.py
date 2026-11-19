"""Generate WISP willow-leaf icons from shared deterministic vector geometry."""
from pathlib import Path
from math import hypot
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
RES = ROOT / 'android/app/src/main/res'
PUBLIC = ROOT / 'public'
RUST_ICONS = ROOT / 'src-tauri/icons'

# Shared 108-unit outline; leaves stay distinct at small Windows icon sizes.
LEAVES = [
    ((35, 35), (25, 43), (23, 59), (31, 75), (39, 59), (45, 47), (35, 35)),
    ((55, 29), (42, 40), (42, 62), (51, 82), (65, 62), (69, 43), (55, 29)),
    ((75, 35), (64, 43), (65, 58), (75, 72), (83, 59), (87, 44), (75, 35)),
]
BRANCH = ((30, 35), (43, 25), (63, 24), (79, 36))


def bezier(points, steps=64):
    start, a, b, end = points
    return [tuple((1-t)**3*start[i] + 3*(1-t)**2*t*a[i] + 3*(1-t)*t*t*b[i] + t**3*end[i]
                  for i in (0, 1)) for t in [n / steps for n in range(steps + 1)]]


def path_data(leaf):
    first, a, b, end, c, d, last = leaf
    return f'M{first[0]},{first[1]} C{a[0]},{a[1]} {b[0]},{b[1]} {end[0]},{end[1]} C{c[0]},{c[1]} {d[0]},{d[1]} {last[0]},{last[1]} Z'


def logo_mask(size, safe=False):
    mask = Image.new('L', (size, size))
    draw = ImageDraw.Draw(mask)
    factor = .88 if safe else 1
    def scale(points):
        return [((54+(x-54)*factor)*size/108, (54+(y-54)*factor)*size/108) for x, y in points]
    for leaf in LEAVES:
        draw.polygon(scale(bezier(leaf[:4]) + bezier((leaf[3], *leaf[4:]))), fill=255)
    draw.line(scale(bezier(BRANCH)), fill=255, width=max(1, round(size/108*2.25*factor)), joint='curve')
    return mask


def icon(size, foreground=False, circle=False):
    canvas = Image.new('RGBA', (size, size))
    if not foreground:
        pixels = canvas.load()
        for y in range(size):
            for x in range(size):
                mix = (x+y)/(2*size)
                glow = max(0, 1-hypot(x/size-.2, y/size-.15))*.25
                rgb = [round(a+(b-a)*mix) for a, b in zip((249, 255, 251), (218, 237, 244))]
                pixels[x, y] = tuple(round(c+(255-c)*glow) for c in rgb)+(255,)
        tile = Image.new('L', (size, size))
        draw = ImageDraw.Draw(tile)
        if circle:
            draw.ellipse((0, 0, size-1, size-1), fill=255)
        else:
            draw.rounded_rectangle((0, 0, size-1, size-1), radius=size*.235, fill=255)
        canvas.putalpha(tile)
    mask = logo_mask(size, safe=foreground)
    if not foreground:
        shadow = Image.new('RGBA', (size, size), (30, 116, 127, 0))
        shadow.putalpha(mask.filter(ImageFilter.GaussianBlur(size*.012)).point(lambda a: round(a*.18)))
        canvas = Image.alpha_composite(canvas, shadow)
    leaves = Image.new('RGBA', (size, size))
    draw = ImageDraw.Draw(leaves)
    for y in range(size):
        mix = max(0, min(1, (y/size-.23)/.56))
        rgb = tuple(round(a+(b-a)*mix) for a, b in zip((23, 170, 132), (52, 106, 216)))
        draw.line((0, y, size, y), fill=rgb+(255,))
    leaves.putalpha(mask)
    return Image.alpha_composite(canvas, leaves)


def svg():
    shapes = ''.join(f'<path d="{path_data(leaf)}"/>' for leaf in LEAVES)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" role="img" aria-label="WISP willow leaves">
<defs><linearGradient id="glass" x2="1" y2="1"><stop stop-color="#F9FFFB"/><stop offset="1" stop-color="#DAEDF4"/></linearGradient><linearGradient id="leaves" gradientUnits="userSpaceOnUse" x1="54" y1="25" x2="54" y2="85"><stop stop-color="#17AA84"/><stop offset="1" stop-color="#346AD8"/></linearGradient></defs>
<rect x=".5" y=".5" width="107" height="107" rx="25" fill="url(#glass)" stroke="#FFFFFF"/>
<g fill="url(#leaves)">{shapes}<path d="M30,35 C43,25 63,24 79,36" fill="none" stroke="url(#leaves)" stroke-width="2.25" stroke-linecap="round"/></g></svg>\n'''


def adaptive_vector(monochrome=False):
    shapes = []
    for leaf in LEAVES:
        if monochrome:
            shapes.append(f'    <path android:fillColor="#FF000000" android:pathData="{path_data(leaf)}" />')
        else:
            shapes.append(f'''    <path android:pathData="{path_data(leaf)}"><aapt:attr name="android:fillColor"><gradient android:startX="54" android:startY="25" android:endX="54" android:endY="85" android:type="linear"><item android:offset="0" android:color="#17AA84"/><item android:offset="1" android:color="#346AD8"/></gradient></aapt:attr></path>''')
    color = '#FF000000' if monochrome else '#1BA98D'
    shapes.append(f'    <path android:fillColor="#00000000" android:strokeColor="{color}" android:strokeWidth="2.25" android:strokeLineCap="round" android:pathData="M30,35 C43,25 63,24 79,36" />')
    return f'''<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android" xmlns:aapt="http://schemas.android.com/aapt" android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108">
<group android:pivotX="54" android:pivotY="54" android:scaleX="0.88" android:scaleY="0.88">
{chr(10).join(shapes)}
</group></vector>\n'''


def main():
    PUBLIC.mkdir(exist_ok=True)
    RUST_ICONS.mkdir(parents=True, exist_ok=True)
    master = icon(1024)
    for filename in ['wisp-icon.png', 'icon.png']:
        master.save(PUBLIC / filename)
    (PUBLIC / 'wisp-icon.svg').write_text(svg(), encoding='utf-8')
    master.save(PUBLIC / 'wisp-icon.ico', sizes=[(n, n) for n in [16, 20, 24, 32, 40, 48, 64, 128, 256]])
    (RUST_ICONS / 'wisp.ico').write_bytes((PUBLIC / 'wisp-icon.ico').read_bytes())
    master.resize((512, 512), Image.Resampling.LANCZOS).save(RUST_ICONS / 'wisp.png')
    for density, factor in {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}.items():
        folder = RES / f'mipmap-{density}'
        folder.mkdir(exist_ok=True)
        for filename, size, foreground, circle in [('ic_launcher.png', round(48*factor), False, False), ('ic_launcher_round.png', round(48*factor), False, True), ('ic_launcher_foreground.png', round(108*factor), True, False)]:
            icon(size*3, foreground, circle).resize((size, size), Image.Resampling.LANCZOS).save(folder / filename)
    (RES / 'drawable/ic_launcher_wisp.xml').write_text(adaptive_vector(), encoding='utf-8')
    (RES / 'drawable/ic_launcher_book.xml').write_text(adaptive_vector(), encoding='utf-8')
    (RES / 'drawable/ic_launcher_wisp_monochrome.xml').write_text(adaptive_vector(True), encoding='utf-8')
    (RES / 'drawable-v24/ic_launcher_foreground.xml').write_text(adaptive_vector(), encoding='utf-8')
    background = '''<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle"><gradient android:angle="135" android:startColor="#F9FFFB" android:centerColor="#EBF7F4" android:endColor="#DAEDF4"/></shape>\n'''
    for filename in ['ic_launcher_glass_background.xml', 'ic_launcher_background.xml']:
        (RES / 'drawable' / filename).write_text(background, encoding='utf-8')
    for api in ['v26', 'v33']:
        for filename in ['ic_launcher.xml', 'ic_launcher_round.xml']:
            (RES / f'mipmap-anydpi-{api}' / filename).write_text('''<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_glass_background" />
    <foreground android:drawable="@drawable/ic_launcher_wisp" />
    <monochrome android:drawable="@drawable/ic_launcher_wisp_monochrome" />
</adaptive-icon>\n''', encoding='utf-8')
    preview = ROOT / '.playwright-mcp/branding'
    preview.mkdir(parents=True, exist_ok=True)
    sheet = Image.new('RGB', (1152, 640), '#e8eff1')
    draw = ImageDraw.Draw(sheet)
    draw.text((38, 25), 'WISP / WISP RS - Willow leaf icon', fill='#25453e', font_size=24)
    large = master.resize((450, 450), Image.Resampling.LANCZOS)
    sheet.paste(large, (38, 100), large)
    for index, size in enumerate([16, 24, 32, 48, 64, 128]):
        x, y = 555+index%3*180, 130+index//3*250
        sample = master.resize((size, size), Image.Resampling.LANCZOS)
        sheet.paste(sample, (x, y), sample)
        draw.text((x, y+max(size, 80)+20), f'{size} px', fill='#25453e', font_size=18)
    sheet.save(preview / 'wisp-icon-preview.png')
    print('Generated WISP SVG, PNG, ICO and Android launcher/adaptive icons.')


if __name__ == '__main__':
    main()
