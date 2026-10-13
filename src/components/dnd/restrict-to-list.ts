import { Modifier } from "@dnd-kit/abstract";
import type { DragDropManager, DragOperation } from "@dnd-kit/abstract";

/**
 * Keeps the dragged item inside the visible list: clamps movement along the
 * list's axis to the list's bounds and locks the other axis.
 *
 * Reads the LIVE shape off the manager instead of the snapshot passed to
 * apply(): @dnd-kit snapshots shapes with for..in, which drops prototype
 * getters like boundingRectangle/current, leaving them undefined.
 */
export class RestrictToList extends Modifier<
    DragDropManager<any, any>,
    { getBounds: () => DOMRect | null; axis?: "x" | "y" }
> {
    apply(operation: DragOperation) {
        const bounds = this.options?.getBounds();
        const axis = this.options?.axis ?? "x";
        // Clamp against the INITIAL rect: dnd-kit rewrites shape.current
        // every frame to include our own transform, so clamping against it
        // would feed our output back into the input.
        const initialRect =
            this.manager.dragOperation.shape?.initial.boundingRectangle;
        if (!bounds || !initialRect) return { ...operation.transform };

        const clamp = (value: number, min: number, max: number) =>
            Math.min(Math.max(value, min), max);

        return axis === "x"
            ? {
                  x: clamp(
                      operation.transform.x,
                      bounds.left - initialRect.left,
                      bounds.right - initialRect.width - initialRect.left
                  ),
                  y: 0,
              }
            : {
                  x: 0,
                  y: clamp(
                      operation.transform.y,
                      bounds.top - initialRect.top,
                      bounds.bottom - initialRect.height - initialRect.top
                  ),
              };
    }
}
