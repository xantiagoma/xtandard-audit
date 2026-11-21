"""The @xtandard/audit mark: the family X (chevron + lower stroke + short upper arm) with a shield on the arm.

All geometry is in mark units (docs/BRAND.md, Geometry). Tune the constants below, then rerun build.py.
"""

from geom import f, rounded_polygon, intersect, offset_polyline

# Body grid: the X is H high, top at y=0.
H = 260.0
S = 0.9  # dx per dy of every diagonal (a bit steeper than 45 degrees, like the siblings)
W = 92.0  # horizontal width of every stroke
GAP = 26.0  # horizontal gap between the chevron and the two right strokes
# shield size, its x offset from the arm top's centre, and how far its point sinks into the arm
SHIELD_W, SHIELD_H, SHIELD_DX, SHIELD_TIP = 114.0, 124.0, 4.0, 8.0
ARM_TOP = 44.0  # y of the short upper arm flat top


def vline(x0, slope):
    """Line x = x0 + slope*y as (point, direction)."""
    return ((x0, 0.0), (slope, 1.0))


def hline(y):
    return ((0.0, y), (1.0, 0.0))


def body():
    C = H / 2
    chevron = [(0, 0), (W, 0), (W + S * C, C), (W, H), (0, H), (S * C, C)]
    # "\" band (continues the chevron's upper arm) and "/" band (its lower arm).
    bs_in, bs_out = vline(0, S), vline(W, S)
    fs_in, fs_out = vline(S * H, -S), vline(W + S * H, -S)
    cut_low = vline(W + GAP + S * H, -S)  # parallel to the chevron's lower outer edge
    cut_up = vline(W + GAP, S)  # parallel to the chevron's upper outer edge
    lower = [
        intersect(bs_in, cut_low),
        intersect(bs_out, cut_low),
        intersect(bs_out, hline(H)),
        intersect(bs_in, hline(H)),
    ]
    upper = [
        intersect(fs_in, cut_up),
        intersect(fs_in, hline(ARM_TOP)),
        intersect(fs_out, hline(ARM_TOP)),
        intersect(fs_out, cut_up),
    ]
    return chevron, lower, upper


def shield(cx, y0, w, h, r=10):
    """Heater shield, flat top, point down; returns (outline d, check outline points)."""
    l, rr = cx - w / 2, cx + w / 2
    k = y0 + h * 0.40
    d = (
        f"M{f(l + r)} {f(y0)}H{f(rr - r)}Q{f(rr)} {f(y0)} {f(rr)} {f(y0 + r)}V{f(k)}"
        f"C{f(rr)} {f(y0 + h * 0.70)} {f(cx + w * 0.26)} {f(y0 + h * 0.88)} {f(cx)} {f(y0 + h)}"
        f"C{f(cx - w * 0.26)} {f(y0 + h * 0.88)} {f(l)} {f(y0 + h * 0.70)} {f(l)} {f(k)}"
        f"V{f(y0 + r)}Q{f(l)} {f(y0)} {f(l + r)} {f(y0)}Z"
    )
    return d


def check(cx, y0, w, h, sw):
    pts = [
        (cx - w * 0.25, y0 + h * 0.44),
        (cx - w * 0.06, y0 + h * 0.63),
        (cx + w * 0.26, y0 + h * 0.27),
    ]
    return offset_polyline(pts, sw)


def mark():
    """Returns the path d strings (all filled with one gradient; the check is an even-odd hole) and the bbox."""
    chevron, lower, upper = body()
    paths = [
        rounded_polygon(chevron, [14, 10, 18, 10, 14, 6]),
        rounded_polygon(lower, [8, 8, 10, 10]),
        rounded_polygon(upper, [8, 10, 10, 8]),
    ]
    # the shield stands on the arm: its point centred on the arm's flat top
    sw_, sh_ = SHIELD_W, SHIELD_H
    cx = (upper[1][0] + upper[2][0]) / 2 + SHIELD_DX
    y0 = ARM_TOP + SHIELD_TIP - sh_
    sd = shield(cx, y0, sw_, sh_)
    ck = check(cx, y0, sw_, sh_, 24)
    ckd = rounded_polygon(list(reversed(ck)), [4, 3, 4, 4, 3, 4])
    paths.append(sd + ckd)
    xs = [p[0] for p in chevron + lower + upper] + [cx - sw_ / 2, cx + sw_ / 2]
    ys = [p[1] for p in chevron + lower + upper] + [y0, y0 + sh_]
    return paths, (min(xs), min(ys), max(xs), max(ys))
