"""生成应用图标（Nebula 星云影库）。
运行：python scripts/make-icon.py
产出：build/icon.png (1024) 与 build/icon.ico（多尺寸，供 electron-builder 使用）
图标语义：深色圆角底 + 蓝紫渐变 + 白色四角星（对应 UI 里的 ✦ 标记）。
"""

import math
import os

from PIL import Image, ImageDraw

SIZE = 1024
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "build")


def vertical_gradient(size: int, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    grad = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / max(1, size - 1)
        grad.putpixel(
            (0, y),
            (
                int(top[0] + (bottom[0] - top[0]) * t),
                int(top[1] + (bottom[1] - top[1]) * t),
                int(top[2] + (bottom[2] - top[2]) * t),
            ),
        )
    return grad.resize((size, size), Image.BILINEAR)


def star_points(cx: float, cy: float, outer: float, inner: float) -> list[tuple[float, float]]:
    pts: list[tuple[float, float]] = []
    for i in range(8):
        angle = math.pi / 4 * i - math.pi / 2
        r = outer if i % 2 == 0 else inner
        pts.append((cx + r * math.cos(angle), cy + r * math.sin(angle)))
    return pts


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)

    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    grad = vertical_gradient(SIZE, (0x2F, 0x6B, 0xD8), (0x6F, 0x4C, 0xF0))

    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=int(SIZE * 0.22), fill=255)
    img.paste(grad, (0, 0), mask)

    draw = ImageDraw.Draw(img)
    cx = cy = SIZE / 2
    draw.polygon(star_points(cx, cy, SIZE * 0.30, SIZE * 0.085), fill=(255, 255, 255, 255))

    for dx, dy, r, alpha in [
        (-0.30, -0.28, 0.022, 200),
        (0.30, -0.20, 0.016, 170),
        (0.26, 0.30, 0.020, 180),
        (-0.26, 0.28, 0.014, 150),
    ]:
        rr = r * SIZE
        px, py = cx + dx * SIZE, cy + dy * SIZE
        draw.ellipse([px - rr, py - rr, px + rr, py + rr], fill=(255, 255, 255, alpha))

    png_path = os.path.join(OUT_DIR, "icon.png")
    ico_path = os.path.join(OUT_DIR, "icon.ico")
    img.save(png_path)
    img.resize((256, 256), Image.LANCZOS).save(
        ico_path,
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print(f"icon.png  {os.path.getsize(png_path)} bytes")
    print(f"icon.ico  {os.path.getsize(ico_path)} bytes")


if __name__ == "__main__":
    main()
