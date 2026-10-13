import { cn } from "@/lib/utils";

import { COLORED_BASE } from "./button";

export function GridProgress({
    value,
    size,
}: {
    value: number;
    size: { cols: number; rows: number };
}) {
    const totalCells = size.rows * size.cols;
    const filledCells = Math.round((value / 100) * totalCells);
    const cells = Array.from({ length: totalCells }, (_, i) => i);

    return (
        <div
            className="grid gap-1"
            style={{
                gridTemplateColumns: `repeat(${size.cols}, 1fr)`,
                gridTemplateRows: `repeat(${size.rows}, 1fr)`,
            }}
        >
            {cells.map((index) => (
                <div
                    key={index}
                    className={cn(
                        "h-2 w-auto rounded transition-[background-color,box-shadow] duration-200",
                        index < filledCells
                            ? cn("bg-info shadow-info/24", COLORED_BASE)
                            : "bg-secondary"
                    )}
                />
            ))}
        </div>
    );
}
