"use no memo";

import { createRootRoute, createRoute, Outlet } from "@tanstack/react-router";

import { resolveTitleBadge } from "@/components/titlebar/title-badge-registry";
import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyTitle,
} from "@/components/ui/empty";
import { TabContext } from "@/contexts/tab-context";
import { setTabTitle } from "@/stores/app-store";

import { ClipsPage } from "./clips-page";
import { EditorPage } from "./editor-page";
import { GameDetailPage } from "./game-detail-page";
import { GamesPage } from "./games-page";
import { GroupDetailPage } from "./group-detail-page";
import { GroupsPage } from "./groups-page";
import { SettingsPage } from "./settings-page";

/**
 * Fresh route-tree instances per call: routers mutate their route nodes
 * internally, so trees are never shared between live routers.
 *
 * Loaders write the tab title into the app store so a restored tab is
 * labelled before its page mounts, and the title stays correct while the
 * tab is inactive.
 */
export function createTabRouteTree(options: { tabId?: string } = {}) {
    const tabId = options.tabId ?? null;

    const rootRoute = createRootRoute({
        component: () => (
            <TabContext.Provider value={tabId}>
                <Outlet />
            </TabContext.Provider>
        ),
        notFoundComponent: () => (
            <div className="size-full">
                <Empty>
                    <EmptyHeader>
                        <EmptyTitle>Not Found</EmptyTitle>
                        <EmptyDescription>
                            This page was not found
                        </EmptyDescription>
                    </EmptyHeader>
                </Empty>
            </div>
        ),
    });

    // Trees built without a tab id belong to non-tab routers.
    const applyTitle = (title: string, badgeKey?: string) => {
        if (tabId === null) return;
        setTabTitle(tabId, title, resolveTitleBadge(badgeKey));
    };

    const clipsRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: "/",
        component: ClipsPage,
        loader: () => applyTitle("Clips"),
    });

    const editorRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: "/clips/edit",
        validateSearch: (search: Record<string, unknown>) => ({
            videoPath:
                typeof search.videoPath === "string" ? search.videoPath : "",
            videoName:
                typeof search.videoName === "string" ? search.videoName : "",
        }),
        component: EditorPage,
        loader: () => applyTitle("Editor", "editor"),
    });

    const gamesRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: "/games",
        component: GamesPage,
        loader: () => applyTitle("Games"),
    });

    const gameDetailRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: "/games/$gameName",
        component: GameDetailPage,
        loader: ({ params }) => applyTitle(decodeURIComponent(params.gameName)),
    });

    const groupsRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: "/groups",
        component: GroupsPage,
        loader: () => applyTitle("Groups"),
    });

    const groupDetailRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: "/groups/$groupId",
        component: GroupDetailPage,
        loader: () => applyTitle("Group"),
    });

    const settingsRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: "/settings",
        component: SettingsPage,
        loader: () => applyTitle("Settings"),
    });

    return rootRoute.addChildren([
        clipsRoute,
        editorRoute,
        gamesRoute,
        gameDetailRoute,
        groupsRoute,
        groupDetailRoute,
        settingsRoute,
    ]);
}
