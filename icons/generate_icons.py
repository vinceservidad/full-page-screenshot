#!/usr/bin/env python3
"""Generate the extension's PNG icons (no third-party deps).

Draws a rounded indigo tile with a white camera "lens" ring and a cyan
center, at every size Chrome asks for. Run:  python3 generate_icons.py
"""
import os
import struct
import zlib
import math

BG = (99, 102, 241)      # indigo  #6366F1
ACCENT = (34, 211, 238)  # cyan    #22D3EE
WHITE = (255, 255, 255)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def rounded(x, y, n, radius):
    """True if pixel is inside the rounded-square mask."""
    r = radius
    cx = min(max(x, r), n - 1 - r)
    cy = min(max(y, r), n - 1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def make_icon(n):
    px = bytearray()
    c = (n - 1) / 2.0
    radius = n * 0.22
    r_lens = n * 0.30   # white lens outer radius
    r_inner = n * 0.17  # cyan center radius
    r_hi = n * 0.06     # small highlight
    hi_c = (c - n * 0.11, c - n * 0.11)

    for y in range(n):
        px.append(0)  # PNG filter byte for this scanline
        for x in range(n):
            if not rounded(x, y, n, radius):
                px.extend((0, 0, 0, 0))  # transparent outside the tile
                continue

            d = math.hypot(x - c, y - c)
            # vertical gradient on the background for a bit of depth
            g = lerp(BG, lerp(BG, (79, 70, 229), 0.6), y / n)
            color = g

            if d <= r_lens:
                color = WHITE
            if d <= r_inner:
                color = ACCENT
            dh = math.hypot(x - hi_c[0], y - hi_c[1])
            if dh <= r_hi and d <= r_lens:
                color = WHITE

            px.extend((color[0], color[1], color[2], 255))
    return bytes(px)


def write_png(path, n, raw):
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", n, n, 8, 6, 0, 0, 0)  # 8-bit RGBA
    idat = zlib.compress(raw, 9)
    with open(path, "wb") as f:
        f.write(sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b""))


def padded(n, inner):
    """make_icon(inner) centred on a transparent n x n canvas."""
    tile = make_icon(inner)
    off = (n - inner) // 2
    row = inner * 4 + 1  # filter byte + RGBA
    px = bytearray()
    for y in range(n):
        px.append(0)
        if off <= y < off + inner:
            src = tile[(y - off) * row + 1:(y - off + 1) * row]
            px.extend(b"\x00" * (off * 4) + src + b"\x00" * ((n - off - inner) * 4))
        else:
            px.extend(b"\x00" * (n * 4))
    return bytes(px)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    for n in (16, 32, 48, 128):
        write_png(os.path.join(here, f"icon{n}.png"), n, make_icon(n))
        print(f"wrote icon{n}.png")
    # Chrome Web Store listing icon: 96 px artwork + 16 px transparent padding.
    store = os.path.join(os.path.dirname(here), "store")
    os.makedirs(store, exist_ok=True)
    write_png(os.path.join(store, "icon-128.png"), 128, padded(128, 96))
    print("wrote store/icon-128.png")


if __name__ == "__main__":
    main()
