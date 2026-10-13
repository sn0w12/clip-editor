import { CollisionType } from "@dnd-kit/abstract";
import type { CollisionDetector, UniqueIdentifier } from "@dnd-kit/abstract";

export const TAB_SWAP_DEAD_ZONE_PX = 8;

interface IndexedEntity {
    readonly id?: UniqueIdentifier;
    readonly index?: unknown;
    readonly sortable?: {
        readonly id?: UniqueIdentifier;
        readonly index?: unknown;
    };
}

function resolveIndex(entity: IndexedEntity | null | undefined) {
    if (!entity || typeof entity !== "object") return null;
    const sortable = entity.sortable;
    if (
        sortable &&
        typeof sortable.index === "number" &&
        sortable.id !== undefined
    ) {
        return { id: sortable.id, index: sortable.index };
    }
    if (typeof entity.index === "number" && entity.id !== undefined) {
        return { id: entity.id, index: entity.index };
    }
    return null;
}

interface RectLike {
    left?: unknown;
    right?: unknown;
    width?: unknown;
    center?: { x?: unknown };
}

function rect(
    shape: unknown
): { left: number; right: number; center: number; width: number } | null {
    const value = shape as RectLike | null | undefined;
    const center = typeof value?.center?.x === "number" ? value.center.x : null;
    const width = typeof value?.width === "number" ? value.width : null;
    const left = typeof value?.left === "number" ? value.left : null;
    const right = typeof value?.right === "number" ? value.right : null;
    if (center !== null) {
        const resolvedWidth = width ?? 0;
        return {
            left: center - resolvedWidth / 2,
            right: center + resolvedWidth / 2,
            center,
            width: resolvedWidth,
        };
    }
    if (left !== null && right !== null) {
        return {
            left,
            right,
            center: (left + right) / 2,
            width: width ?? right - left,
        };
    }
    return null;
}

export function createTabCollisionDetector(
    deadZonePx: number = TAB_SWAP_DEAD_ZONE_PX
): CollisionDetector {
    return ({ droppable, dragOperation }) => {
        const source = resolveIndex(dragOperation.source);
        const candidate = resolveIndex(droppable);
        const dragged = rect(dragOperation.shape?.current);
        const target = rect(droppable.shape);
        if (
            !source ||
            !candidate ||
            !dragged ||
            !target ||
            candidate.id === source.id
        )
            return null;

        const movingRight = candidate.index > source.index;
        const movingLeft = candidate.index < source.index;
        if (!movingRight && !movingLeft) return null;

        const forward = movingRight
            ? dragged.right - target.center
            : target.center - dragged.left;
        if ((!movingRight && !movingLeft) || forward <= deadZonePx) return null;

        return {
            id: candidate.id,
            priority: 0,
            type: CollisionType.Collision,
            value: 1 / (Math.abs(forward - deadZonePx) + 1),
        };
    };
}
