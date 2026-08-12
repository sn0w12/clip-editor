import { imgSrc } from "@/lib/tauri";
import { cn, stringToColor } from "@/lib/utils";
import type { GameImage } from "@/types";

export function GameIcon({
    game,
    gameImage,
    className,
}: {
    game: string;
    gameImage?: GameImage | null;
    className?: string;
}) {
    const icon = gameImage?.icon ?? gameImage?.logo ?? null;

    if (!icon) {
        return (
            <div
                className={cn("size-4 rounded", className)}
                style={{ backgroundColor: stringToColor(game) }}
            />
        );
    }

    return (
        <img
            src={imgSrc(icon)}
            alt={`${game} icon`}
            className={cn("size-4 rounded", className)}
            onError={(e) => {
                e.currentTarget.style.backgroundColor = stringToColor(game);
            }}
        />
    );
}
