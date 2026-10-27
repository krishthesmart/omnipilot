"""Draws the Watcher extension icons (indigo rounded square with a white eye) as PNGs, no dependencies."""
import math, struct, sys, zlib

def png(size, path):
    s = size
    rows = []
    r_corner = s * 0.22
    cx = cy = (s - 1) / 2
    for y in range(s):
        row = bytearray([0])
        for x in range(s):
            # rounded square mask (with 1px antialias)
            dx = max(abs(x - cx) - (s / 2 - r_corner), 0)
            dy = max(abs(y - cy) - (s / 2 - r_corner), 0)
            d = math.hypot(dx, dy) - r_corner
            a = max(0.0, min(1.0, 0.5 - d))
            r, g, b = 0x4F, 0x46, 0xE5  # indigo
            # eye: almond outline + pupil
            ex, ey = (x - cx) / (s * 0.36), (y - cy) / (s * 0.20)
            almond = ex * ex + ey * ey
            pupil = math.hypot(x - cx, y - cy) / (s * 0.12)
            if almond <= 1.0 and (almond >= 0.62 or pupil <= 1.0):
                r, g, b = 255, 255, 255
            row += bytes([r, g, b, int(a * 255)])
        rows.append(bytes(row))
    raw = b"".join(rows)
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", s, s, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    open(path, "wb").write(data)

for size in (16, 32, 48, 128):
    png(size, f"{sys.argv[1]}/icon{size}.png")
