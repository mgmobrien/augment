"""Render the Augment signal tower icon at 1024x1024.

Renders at 2x (2048x2048) and downsamples for clean anti-aliasing.
"""
from PIL import Image, ImageDraw, ImageFilter
import math

RENDER_SIZE = 2048  # 2x for AA
FINAL_SIZE = 1024
SCALE = RENDER_SIZE / FINAL_SIZE
CORNER = int(228 * SCALE)

# Tokyo Night palette
BG_TOP = (0x16, 0x1b, 0x28)
BG_BOT = (0x0f, 0x11, 0x15)
BLUE = (0x7a, 0xa2, 0xf7)
YELLOW = (0xe0, 0xaf, 0x68)
WHITE = (0xd7, 0xdc, 0xe8)
BORDER = (0x1e, 0x25, 0x36)

S = RENDER_SIZE
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)


def s(v):
    """Scale a value from 1024 coordinate space to render space."""
    return int(v * SCALE)


# --- Background rounded rect with vertical gradient ---
bg = Image.new("RGBA", (S, S), (0, 0, 0, 0))
bg_draw = ImageDraw.Draw(bg)
for y in range(S):
    t = y / S
    r = int(BG_TOP[0] * (1 - t) + BG_BOT[0] * t)
    g = int(BG_TOP[1] * (1 - t) + BG_BOT[1] * t)
    b = int(BG_TOP[2] * (1 - t) + BG_BOT[2] * t)
    bg_draw.line([(0, y), (S - 1, y)], fill=(r, g, b, 255))

mask = Image.new("L", (S, S), 0)
mask_draw = ImageDraw.Draw(mask)
mask_draw.rounded_rectangle([0, 0, S - 1, S - 1], radius=CORNER, fill=255)
bg.putalpha(mask)
img.paste(bg, (0, 0), bg)

draw.rounded_rectangle([s(3), s(3), S - s(3), S - s(3)], radius=CORNER - s(3), outline=BORDER, width=s(2))


def thick_line(draw, x1, y1, x2, y2, width, color):
    """Draw a thick line with round caps."""
    dx = x2 - x1
    dy = y2 - y1
    length = math.sqrt(dx * dx + dy * dy)
    if length == 0:
        return
    nx = -dy / length * width / 2
    ny = dx / length * width / 2
    points = [
        (x1 + nx, y1 + ny),
        (x1 - nx, y1 - ny),
        (x2 - nx, y2 - ny),
        (x2 + nx, y2 + ny),
    ]
    draw.polygon(points, fill=color)
    r = width / 2
    draw.ellipse([x1 - r, y1 - r, x1 + r, y1 + r], fill=color)
    draw.ellipse([x2 - r, y2 - r, x2 + r, y2 + r], fill=color)


# --- Tower geometry (all in 1024 space, scaled) ---
cx, cy = s(512), s(540)
mast_top = cy - s(210)

# Main mast
thick_line(draw, cx, mast_top, cx, cy + s(250), s(20), BLUE)

# Upper crossbar
thick_line(draw, cx - s(45), cy + s(60), cx + s(45), cy + s(60), s(13), BLUE)

# Lower crossbar
thick_line(draw, cx - s(70), cy + s(165), cx + s(70), cy + s(165), s(13), BLUE)

# Truss lines
thick_line(draw, cx - s(45), cy + s(60), cx - s(70), cy + s(165), s(9), BLUE)
thick_line(draw, cx + s(45), cy + s(60), cx + s(70), cy + s(165), s(9), BLUE)

# Cross bracing
thick_line(draw, cx - s(45), cy + s(60), cx + s(70), cy + s(165), s(5), (*BLUE[:3], 120))
thick_line(draw, cx + s(45), cy + s(60), cx - s(70), cy + s(165), s(5), (*BLUE[:3], 120))

# Base legs
thick_line(draw, cx - s(70), cy + s(165), cx - s(115), cy + s(290), s(11), BLUE)
thick_line(draw, cx + s(70), cy + s(165), cx + s(115), cy + s(290), s(11), BLUE)

# Ground line
thick_line(draw, cx - s(130), cy + s(290), cx + s(130), cy + s(290), s(7), (*BLUE[:3], 130))

# --- Tower node ---
# Soft glow
for r in range(s(45), s(18), -s(1)):
    alpha = int(35 * (s(45) - r) / s(27))
    draw.ellipse([cx - r, mast_top - r, cx + r, mast_top + r], fill=(*BLUE[:3], alpha))

# Solid blue ring
draw.ellipse([cx - s(20), mast_top - s(20), cx + s(20), mast_top + s(20)], fill=BLUE)
# Inner white dot
draw.ellipse([cx - s(9), mast_top - s(9), cx + s(9), mast_top + s(9)], fill=WHITE)

# --- Signal arcs ---
# Render arcs on separate layers for proper alpha and glow
arc_cx, arc_cy = cx, mast_top

def draw_arc_with_glow(radius, span_deg, width, color, alpha, glow_radius=0):
    """Draw a smooth arc with optional glow."""
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    layer_draw = ImageDraw.Draw(layer)

    start = -90 - span_deg / 2
    end = -90 + span_deg / 2
    bbox = [arc_cx - radius, arc_cy - radius, arc_cx + radius, arc_cy + radius]
    layer_draw.arc(bbox, start, end, fill=(*color[:3], alpha), width=width)

    if glow_radius > 0:
        # Create glow by blurring a copy
        glow = layer.copy()
        glow = glow.filter(ImageFilter.GaussianBlur(radius=glow_radius))
        # Composite glow under the sharp arc
        result = Image.alpha_composite(glow, layer)
        img.paste(Image.alpha_composite(Image.new("RGBA", (S, S), (0, 0, 0, 0)), result), (0, 0), result)
    else:
        img.paste(Image.alpha_composite(Image.new("RGBA", (S, S), (0, 0, 0, 0)), layer), (0, 0), layer)


# Arc 1 — innermost, brightest, strong glow
draw_arc_with_glow(s(100), 130, s(15), YELLOW, 255, glow_radius=s(8))

# Arc 2 — middle
draw_arc_with_glow(s(168), 125, s(11), YELLOW, 200, glow_radius=s(5))

# Arc 3 — outermost
draw_arc_with_glow(s(235), 120, s(8), YELLOW, 120, glow_radius=s(3))

# --- Downsample to 1024 ---
final = img.resize((FINAL_SIZE, FINAL_SIZE), Image.LANCZOS)
final.save("/Users/mattobrien/Development/augment-plugin/build/icon-1024.png")
print("Done: icon-1024.png")
