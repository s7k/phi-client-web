"""寿司のキャラグラ(96x160)を描く。行=向き(後/右/前/左)、列=[小0][小1][大0][大1]。

朱蓮の寿司の魔物(Uni/Toro/Ika/Ebi/Tamago)用に、ネタごとに1枚描く。
握りは底の平らな俵形のシャリに、両端が少し垂れたネタを被せる。軍艦(ウニ)は海苔の円柱に盛る。
後/前は端から見た短い形、右は横長、左は右の左右反転。コマ1は1px跳ねる。

    python3 tools/sushi_gra/gen.py assets/chara [BMP出力先]

BMP出力先を渡すと、旧クライアント用に 8bit パレットの BMP(透過色 teal)も書く。
"""
import random
import sys
import zlib
from PIL import Image

OUT = sys.argv[1]
OUT_BMP = sys.argv[2] if len(sys.argv) > 2 else None
TEAL = (0, 128, 128)  # 旧クライアントの透過色(clTeal)
OL = (48, 28, 34)
RICE = dict(top=(252, 251, 242), side=(232, 229, 214), dark=(200, 196, 180), grain=(255, 255, 255), dot=(214, 210, 194))
NORI = dict(top=(64, 82, 60), side=(36, 48, 36), dark=(22, 30, 22))
NETA = {
    'uni':    dict(top=(250, 186, 64), side=(226, 140, 34), dark=(182, 96, 20), hi=(255, 226, 120)),
    'toro':   dict(top=(250, 170, 176), side=(226, 112, 124), dark=(186, 70, 88), hi=(255, 232, 232)),
    'ika':    dict(top=(236, 244, 255), side=(190, 210, 238), dark=(140, 166, 206), hi=(255, 255, 255)),
    'ebi':    dict(top=(255, 196, 170), side=(246, 112, 72), dark=(200, 64, 40), hi=(255, 240, 228)),
    'tamago': dict(top=(255, 228, 110), side=(240, 196, 56), dark=(196, 148, 30), hi=(255, 246, 180)),
}


class Canvas:
    def __init__(self, w, h):
        self.w, self.h = w, h
        self.px = [[None] * w for _ in range(h)]

    def put(self, x, y, c):
        if 0 <= x < self.w and 0 <= y < self.h:
            self.px[y][x] = c

    def get(self, x, y):
        return self.px[y][x] if 0 <= x < self.w and 0 <= y < self.h else None


def in_ell(x, y, cx, cy, rx, ry):
    return ((x + .5 - cx) / rx) ** 2 + ((y + .5 - cy) / ry) ** 2 <= 1


def block(cv, cx, top_y, rx, ry, height, col, light=True):
    """上面楕円(中心 top_y)と高さ height の側面を持つ塊。"""
    for y in range(cv.h):
        for x in range(cv.w):
            on_top = in_ell(x, y, cx, top_y, rx, ry)
            on_bot = in_ell(x, y, cx, top_y + height, rx, ry)
            on_side = abs(x + .5 - cx) <= rx and top_y <= y + .5 <= top_y + height
            if on_top:
                # 左上を明るく
                d = (x + .5 - cx) / rx + (y + .5 - top_y) / ry
                cv.put(x, y, col['hi'] if light and d < -.9 and 'hi' in col else col['top'])
            elif on_side or on_bot:
                # 側面: 右側を暗く
                cv.put(x, y, col['dark'] if (x + .5 - cx) / rx > .45 else col['side'])


def outline(cv):
    src = [r[:] for r in cv.px]
    for y in range(cv.h):
        for x in range(cv.w):
            if src[y][x] is None and any(
                0 <= y + dy < cv.h and 0 <= x + dx < cv.w and src[y + dy][x + dx] is not None
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
                cv.put(x, y, OL)


def sushi(name, w, bob, end_view):
    cv = Canvas(w, 32)
    big = w == 32
    # hash() は実行ごとに変わるので crc32 で種を固定する
    rnd = random.Random(zlib.crc32(f'{name}:{w}:{end_view}'.encode()))
    cx = w / 2
    rx = (8.5 if end_view else 12.5) if big else (5.2 if end_view else 6.6)
    ry = 4.0 if big else 2.6
    base = 31 - 3 - bob                 # 底(輪郭の分あける)
    n = NETA[name]
    if name == 'uni':
        hgt = 9 if big else 6
        top = base - ry - hgt
        block(cv, cx, top, rx, ry, hgt, NORI, light=False)
        # 盛ったウニ: 上面より少し盛り上がる
        dome = Canvas(w, 32)
        block(dome, cx, top - (1.5 if big else 1), rx - .5, ry + (.5 if big else 0), 1.5, n)
        for y in range(32):
            for x in range(w):
                if dome.px[y][x] is not None:
                    cv.put(x, y, dome.px[y][x])
        for _ in range(18 if big else 6):
            x = int(cx - rx * .8 + rnd.random() * rx * 1.6)
            y = int(top - ry + rnd.random() * ry * 1.8)
            if cv.get(x, y) in (n['top'], n['hi']):
                cv.put(x, y, n['side'] if rnd.random() < .5 else n['hi'])
        outline(cv)
        return cv
    # シャリ: 底を平らにした俵形。左上を明るく、右下を暗く
    rry = (5.5 if big else 3.6)
    rcy = base - rry + (1.5 if big else 1)
    for y in range(32):
        for x in range(w):
            if in_ell(x, y, cx, rcy, rx, rry) and y <= base:
                d = (x + .5 - cx) / rx * .6 + (y + .5 - rcy) / rry
                cv.put(x, y, RICE['top'] if d < -.2 else RICE['side'] if d < .75 else RICE['dark'])
    for _ in range(26 if big else 7):
        x = int(cx - rx + rnd.random() * rx * 2)
        y = int(rcy - rry + rnd.random() * rry * 2)
        if cv.get(x, y) in (RICE['side'], RICE['top']):
            cv.put(x, y, RICE['dot'] if rnd.random() < .6 else RICE['grain'])
    # ネタ: シャリより長い楕円の上半分を被せ、両端はシャリの外で少し垂らす
    nrx = rx + (2 if big else 1)
    thick = {'tamago': 5 if big else 3, 'toro': 3.2 if big else 1.8, 'ika': 3.2 if big else 1.8}.get(name, 2.6 if big else 1.6)
    ncy = rcy - rry * .35
    nry = rry * .75 + thick
    for y in range(32):
        for x in range(w):
            if not in_ell(x, y, cx, ncy, nrx, nry):
                continue
            u = (x + .5 - cx) / nrx
            # 下端の線: 中央はシャリの上、端ほど下がる(垂れ)
            lower = ncy - nry + thick * 2 + (abs(u) ** 2) * (3 if big else 2)
            if y + .5 > lower:
                continue
            d = u * .5 + (y + .5 - (ncy - nry)) / (thick * 2 + 2)
            cv.put(x, y, n['hi'] if d < .05 else n['top'] if d < .55 else n['side'] if d < .95 else n['dark'])
    top_y = int(ncy - nry)
    if name == 'toro':
        # 斜めの脂の筋
        for k in range(-5, 6, 2 if big else 3):
            for t in range(10):
                x, y = int(cx + k * 2.4 + t * .7), top_y + 1 + t
                if cv.get(x, y) in (n['top'], n['side']):
                    cv.put(x, y, n['hi'])
    if name == 'ebi':
        # 縞(殻の節)
        for k in range(-4, 5):
            x = int(cx + k * nrx / 4.5)
            for y in range(top_y, top_y + 12):
                if cv.get(x, y) in (n['top'], n['side'], n['hi']):
                    cv.put(x, y, (236, 84, 52))
    if name == 'ika':
        for k in (-3, -1, 1, 3) if big else (-1, 1):
            x = int(cx + k * nrx / 5)
            for y in range(top_y + 1, top_y + (4 if big else 2)):
                if cv.get(x, y) in (n['top'], n['hi']):
                    cv.put(x, y, n['side'])
    if name == 'tamago':
        for x in range(int(cx - nrx * .6), int(cx + nrx * .6)):
            if rnd.random() < .35 and cv.get(x, top_y + 1) in (n['top'], n['hi']):
                cv.put(x, top_y + 1, n['dark'])
    if name in ('tamago',):
        bw = 3 if big else 2
        for y in range(32):
            for x in range(int(cx - bw / 2), int(cx - bw / 2) + bw):
                if cv.get(x, y) is not None:
                    cv.put(x, y, NORI['top'] if x == int(cx - bw / 2) else NORI['side'])
    if name == 'ebi' and not end_view:
        tx, ty = int(cx + nrx) - 1, top_y + (2 if big else 1)
        tail = [(0, 0), (1, -1), (2, -2), (3, -3), (1, 0), (2, -1), (3, -2), (2, 0), (4, -3), (4, -4)] if big else [(0, 0), (1, -1), (1, 0), (2, -1)]
        for dx, dy in tail:
            cv.put(tx + dx, ty + dy, (214, 54, 36))
    outline(cv)
    return cv


def sprite(name):
    img = Image.new('RGBA', (96, 160), (0, 0, 0, 0))
    for row in range(4):
        end_view = row in (0, 2)
        for f in range(2):
            for x0, w in ((f * 16, 16), (32 + f * 32, 32)):
                cv = sushi(name, w, f, end_view)
                tile = Image.new('RGBA', (w, 32), (0, 0, 0, 0))
                for y in range(32):
                    for x in range(w):
                        if cv.px[y][x] is not None:
                            tile.putpixel((x, y), cv.px[y][x] + (255,))
                if row == 3:
                    tile = tile.transpose(Image.FLIP_LEFT_RIGHT)
                img.alpha_composite(tile, (x0, row * 32))
    return img


def to_bmp(img):
    """透過部分を teal で埋め、8bit パレットにする(色数は 256 未満なので減色しない)。"""
    bg = Image.new('RGBA', img.size, TEAL + (255,))
    bg.alpha_composite(img)
    rgb = bg.convert('RGB')
    colors = rgb.getcolors(256)
    assert colors is not None, '256 色を超えた'
    pal = rgb.quantize(colors=len(colors), method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    # パレットは旧クライアントの BMP と同じく 256 色分にする(使わない色は黒)
    p = pal.getpalette()[:3 * len(colors)]
    pal.putpalette(p + [0] * (768 - len(p)))
    return pal


for name in NETA:
    img = sprite(name)
    img.save(f'{OUT}/sushi_{name}.png')
    if OUT_BMP:
        to_bmp(img).save(f'{OUT_BMP}/sushi_{name}.bmp')
