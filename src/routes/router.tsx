// TanStack Router route tree (memory history, matching the legacy app's
// route surface minus /performance).

import {
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
} from "@tanstack/react-router";

import { BaseLayout } from "@/components/shell/base-layout";
import { EditPage } from "@/pages/edit-page";
import { GamesPage } from "@/pages/games-page";
import { GroupsPage } from "@/pages/groups-page";
import { HomePage } from "@/pages/home-page";
import { GameDetailPage } from "@/pages/individual-games-page";
import { GroupDetailPage } from "@/pages/individual-groups-page";
import { NotFoundPage } from "@/pages/not-found-page";
import { SettingsPage } from "@/pages/settings-page";

export const rootRoute = createRootRoute({
    component: () => <BaseLayout />,
});

export const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: HomePage,
});

export const editVideoRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/clips/edit",
    validateSearch: (search: Record<string, unknown>) => ({
        videoPath: typeof search.videoPath === "string" ? search.videoPath : "",
        videoName: typeof search.videoName === "string" ? search.videoName : "",
    }),
    component: EditPage,
});

export const gamesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/games",
    component: GamesPage,
});

export const gameDetailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/games/$gameName",
    component: GameDetailPage,
});

export const groupsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/groups",
    component: GroupsPage,
});

export const groupDetailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/groups/$groupId",
    component: GroupDetailPage,
});

export const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    component: SettingsPage,
});

export const notFoundRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "*",
    component: NotFoundPage,
});

const routeTree = rootRoute.addChildren([
    homeRoute,
    editVideoRoute,
    gamesRoute,
    gameDetailRoute,
    groupsRoute,
    groupDetailRoute,
    settingsRoute,
    notFoundRoute,
]);

export const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
    interface Register {
        router: typeof router;
    }
}
