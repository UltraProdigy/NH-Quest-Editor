# Regenerates src/gui/bq-presets.json from the BetterQuesting source.
#
# The presets are BetterQuesting's built-in default textures, icons, colors and
# lines (PresetTexture/PresetIcon/PresetColor/PresetLine). Themes only override
# some of them, so the site needs the defaults too.
#
# Usage: python3 scripts/extract-bq-presets.py <BetterQuesting repo> > src/gui/bq-presets.json
import json, re, sys, os

root = sys.argv[1]
pre = os.path.join(root, 'src/main/java/betterquesting/api2/client/gui/themes/presets')
read = lambda n: open(os.path.join(pre, n), encoding='utf-8').read()

def enum_keys(src):
    return dict(re.findall(r'^\s*([A-Z0-9_]+)\("([a-z0-9_]+)"\)', src, re.M))

def tx_consts(src):
    out = {}
    for name, path in re.findall(r'(TX_\w+)\s*=\s*new ResourceLocation\(\s*BetterQuesting\.MODID,\s*"([^"]+)"\)', src):
        out[name] = 'betterquesting:' + path
    return out

TEX_RE = re.compile(
    r'setDefaultTexture\(\s*(\w+)\.key,\s*new (SlicedTexture|SimpleTexture)\((TX_\w+),\s*'
    r'new GuiRectangle\((\d+),\s*(\d+),\s*(\d+),\s*(\d+)\)'
    r'(?:,\s*new GuiPadding\((\d+),\s*(\d+),\s*(\d+),\s*(\d+)\))?\)'
    r'(?:\s*\.setSliceMode\(SliceMode\.(\w+)\))?'
    r'(?:\s*\.maintainAspect\((true|false)\))?', re.S)
SLICE = {'STRETCH': 0, 'SLICED_TILE': 1, 'SLICED_STRETCH': 2}

textures = {}
for f in ('PresetTexture.java', 'PresetIcon.java'):
    src = read(f)
    keys, tx = enum_keys(src), tx_consts(src)
    for m in TEX_RE.finditer(src):
        enum, kind, atlas = m.group(1), m.group(2), m.group(3)
        bounds = [int(m.group(i)) for i in range(4, 8)]
        key = 'betterquesting:' + keys[enum]
        if kind == 'SlicedTexture':
            textures[key] = {
                'textureType': 'betterquesting:texture_sliced',
                'atlas': tx[atlas],
                'bounds': bounds,
                'padding': [int(m.group(i)) for i in range(8, 12)],
                'sliceMode': SLICE[m.group(12) or 'SLICED_TILE'],
            }
        else:
            textures[key] = {
                'textureType': 'betterquesting:texture_simple',
                'atlas': tx[atlas],
                'bounds': bounds,
                'stretch': m.group(13) != 'true',
            }

def color(expr):
    expr = expr.strip()
    m = re.fullmatch(r'new GuiColorStatic\((\d+),\s*(\d+),\s*(\d+),\s*(\d+)\)', expr)
    if m:
        r, g, b, a = map(int, m.groups())
        return {'colorType': 'betterquesting:color_static', 'color': '%02X%02X%02X%02X' % (a, r, g, b)}
    m = re.fullmatch(r'new GuiColorStatic\((\d+)\)', expr)
    if m:
        v = int(m.group(1)) & 0xFFFFFFFF
        if v <= 0xFFFFFF: v |= 0xFF000000  # GuiColorStatic(int) treats a zero alpha as opaque
        return {'colorType': 'betterquesting:color_static', 'color': '%08X' % v}
    m = re.fullmatch(r'new GuiColorPulse\(quickMix\(([^)]*)\),\s*quickMix\(([^)]*)\),\s*([\d.]+)F,\s*([\d.]+)F\)', expr)
    if m:
        c = lambda s: color('new GuiColorStatic(%s)' % s)
        return {'colorType': 'betterquesting:color_pulse', 'period': float(m.group(3)), 'phase': float(m.group(4)),
                'color1': c(m.group(1)), 'color2': c(m.group(2))}
    raise ValueError('unknown color ' + expr)

src = read('PresetColor.java')
keys = enum_keys(src)
colors = {}
for enum, expr in re.findall(r'setDefaultColor\(\s*(\w+)\.key,\s*(new [^;]+?)\);', src, re.S):
    colors['betterquesting:' + keys[enum]] = color(re.sub(r'\s+', ' ', expr))

src = read('PresetLine.java')
keys = enum_keys(src)
lines = {}
for enum, expr in re.findall(r'setDefaultLine\(\s*(\w+)\.key,\s*(new [^;]+?)\);', src, re.S):
    m = re.fullmatch(r'new SimpleLine\((?:(\d+),\s*\(short\)\s*(\d+))?\)', expr)
    if m:
        scale, mask = int(m.group(1) or 1), int(m.group(2) or 0xFFFF)
        lines['betterquesting:' + keys[enum]] = {'lineType': 'betterquesting:line_simple', 'stippleScale': scale,
                                                 'stippleMask': format(mask & 0xFFFF, '016b')}
    elif expr == 'new DirectionalLine()':
        lines['betterquesting:' + keys[enum]] = {'lineType': 'betterquesting:line_directional'}
    else:
        raise ValueError('unknown line ' + expr)

json.dump({'textures': textures, 'colors': colors, 'lines': lines}, sys.stdout, indent=1)
print()
print(f'{len(textures)} textures, {len(colors)} colors, {len(lines)} lines', file=sys.stderr)
