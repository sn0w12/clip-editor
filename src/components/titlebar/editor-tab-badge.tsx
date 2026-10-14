import { useSelector } from "@tanstack/react-store";
import { useMemo } from "react";

import { GameIcon } from "@/components/game-icon";
import { useTitlebarTabId } from "@/contexts/tab-title-context";
import { appStore } from "@/stores/app-store";
import { useClipsStore } from "@/stores/clips-store";
import { gameImageFor, useGamesStore } from "@/stores/games-store";

function editorParams(href: string): { videoPath: string; videoName: string } {
    const query = href.indexOf("?");
    const params = new URLSearchParams(query === -1 ? "" : href.slice(query));
    return {
        videoPath: params.get("videoPath") ?? "",
        videoName: params.get("videoName") ?? "",
    };
}

export function EditorTabBadge() {
    const tabId = useTitlebarTabId();
    const href = useSelector(
        appStore,
        (state) =>
            state.tabs.find((tab) => tab.tabId === tabId)?.lastResolvedHref ??
            ""
    );
    const { videoPath, videoName } = editorParams(href);
    const { clips } = useClipsStore();
    const { games, aliases } = useGamesStore();

    const game = clips.find((clip) => clip.path === videoPath)?.game ?? "";
    const image = useMemo(
        () => gameImageFor(games, aliases, game),
        [games, aliases, game]
    );

    return (
        <span className="flex min-w-0 items-center gap-1.5">
            <GameIcon
                game={game}
                gameImage={image}
                className="size-3.5 shrink-0"
            />
            <span className="min-w-0 truncate">{videoName || "Editor"}</span>
        </span>
    );
}
