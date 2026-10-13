export interface Rect {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

export interface TabBump {
    left: number;
    right: number;
    top: number;
    radius: number;
    leftWing: Rect | null;
    rightWing: Rect | null;
}

export function parsePx(value: string): number {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function fmt(value: number): string {
    return String(Math.round(value * 100) / 100);
}

// SVG arcs with a zero radius degenerate to straight lines per spec.
function arc(radius: number, sweep: number, x: number, y: number): string {
    return `A ${fmt(radius)} ${fmt(radius)} 0 0 ${sweep} ${fmt(x)} ${fmt(y)}`;
}

function clampRadius(radius: number, rect: Rect): number {
    return Math.max(
        0,
        Math.min(
            radius,
            (rect.right - rect.left) / 2,
            (rect.bottom - rect.top) / 2
        )
    );
}

export function roundedRectPath(rect: Rect, radius: number): string {
    const r = clampRadius(radius, rect);
    return [
        `M ${fmt(rect.left + r)} ${fmt(rect.top)}`,
        `H ${fmt(rect.right - r)}`,
        arc(r, 1, rect.right, rect.top + r),
        `V ${fmt(rect.bottom - r)}`,
        arc(r, 1, rect.right - r, rect.bottom),
        `H ${fmt(rect.left + r)}`,
        arc(r, 1, rect.left, rect.bottom - r),
        `V ${fmt(rect.top + r)}`,
        arc(r, 1, rect.left + r, rect.top),
        "Z",
    ].join(" ");
}

// One clockwise outline: the inset rectangle with the tab traced out of its
// top edge. Wing fillets are the concave quarter arcs of the Corner SVGs; the
// 1px slots between each wing and the tab are real geometry and are traced
// into the boundary so no unblurred sliver survives inside the silhouette.
export function insetBackdropClipPath(
    inset: Rect,
    insetRadius: number,
    bump: TabBump | null
): string {
    if (!bump) return roundedRectPath(inset, insetRadius);

    const ir = clampRadius(insetRadius, inset);
    const r = Math.max(
        0,
        Math.min(
            bump.radius,
            (bump.right - bump.left) / 2,
            (inset.top - bump.top) / 2
        )
    );
    const seg: string[] = [`M ${fmt(inset.left + ir)} ${fmt(inset.top)}`];

    const lw = bump.leftWing;
    if (
        lw &&
        lw.left >= inset.left + ir &&
        lw.right <= bump.left &&
        lw.top < inset.top
    ) {
        const w = lw.right - lw.left;
        seg.push(`L ${fmt(lw.left)} ${fmt(inset.top)}`);
        seg.push(arc(w, 0, lw.right, lw.top));
        seg.push(`L ${fmt(lw.right)} ${fmt(inset.top)}`);
        if (bump.left > lw.right) {
            seg.push(`L ${fmt(bump.left)} ${fmt(inset.top)}`);
        }
    } else {
        seg.push(`L ${fmt(bump.left)} ${fmt(inset.top)}`);
    }
    seg.push(`L ${fmt(bump.left)} ${fmt(bump.top + r)}`);
    seg.push(arc(r, 1, bump.left + r, bump.top));
    seg.push(`L ${fmt(bump.right - r)} ${fmt(bump.top)}`);
    seg.push(arc(r, 1, bump.right, bump.top + r));

    const rw = bump.rightWing;
    if (
        rw &&
        rw.right <= inset.right - ir &&
        rw.left >= bump.right &&
        rw.top < inset.top
    ) {
        const w = rw.right - rw.left;
        if (rw.left > bump.right) {
            seg.push(`L ${fmt(rw.left)} ${fmt(inset.top)}`);
        }
        seg.push(`L ${fmt(rw.left)} ${fmt(rw.top)}`);
        seg.push(arc(w, 0, rw.right, inset.top));
    } else {
        seg.push(`L ${fmt(bump.right)} ${fmt(inset.top)}`);
    }

    seg.push(`L ${fmt(inset.right - ir)} ${fmt(inset.top)}`);
    seg.push(arc(ir, 1, inset.right, inset.top + ir));
    seg.push(`L ${fmt(inset.right)} ${fmt(inset.bottom - ir)}`);
    seg.push(arc(ir, 1, inset.right - ir, inset.bottom));
    seg.push(`L ${fmt(inset.left + ir)} ${fmt(inset.bottom)}`);
    seg.push(arc(ir, 1, inset.left, inset.bottom - ir));
    seg.push(`V ${fmt(inset.top + ir)}`);
    seg.push(arc(ir, 1, inset.left + ir, inset.top));
    seg.push("Z");
    return seg.join(" ");
}
