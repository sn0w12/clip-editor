import { createRoute } from "@tanstack/react-router";
import { RootRoute } from "./__root";
import HomePage from "@/pages/home-page";
import SettingsPage from "@/pages/settings-page";
import NotFoundPage from "@/pages/not-found-page";
import EditPage from "@/pages/edit-page";
import GamesPage from "@/pages/games-page";
import GameDetailPage from "@/pages/individual-games-page";
import GroupsPage from "@/pages/groups-page";
import GroupDetailPage from "@/pages/individual-groups-page";

// TODO: Steps to add a new route:
// 1. Create a new page component in the '../pages/' directory (e.g., NewPage.tsx)
// 2. Import the new page component at the top of this file
// 3. Define a new route for the page using createRoute()
// 4. Add the new route to the routeTree in RootRoute.addChildren([...])
// 5. Add a new Link in the navigation section of RootRoute if needed

// Example of adding a new route:
// 1. Create '../pages/NewPage.tsx'
// 2. Import: import NewPage from '../pages/NewPage';
// 3. Define route:
//    const NewRoute = createRoute({
//      getParentRoute: () => RootRoute,
//      path: '/new',
//      component: NewPage,
//    });
// 4. Add to routeTree: RootRoute.addChildren([HomeRoute, NewRoute, ...])
// 5. Add Link: <Link to="/new">New Page</Link>

export const HomeRoute = createRoute({
    getParentRoute: () => RootRoute,
    path: "/",
    component: HomePage,
});

export const SettingsRoute = createRoute({
    getParentRoute: () => RootRoute,
    path: "/settings",
    component: SettingsPage,
});

export const NotFoundRoute = createRoute({
    getParentRoute: () => RootRoute,
    path: "*",
    component: NotFoundPage,
});

export const EditVideoRoute = createRoute({
    getParentRoute: () => RootRoute,
    path: "/clips/edit",
    validateSearch: (search: Record<string, unknown>) => {
        return {
            videoPath: search.videoPath as string,
            videoName: search.videoName as string,
        };
    },
    component: EditPage,
});

export const GamesRoute = createRoute({
    getParentRoute: () => RootRoute,
    path: "/games",
    component: GamesPage,
});

export const GameDetailRoute = createRoute({
    getParentRoute: () => RootRoute,
    path: "/games/$gameName",
    component: GameDetailPage,
});

export const GroupsRoute = createRoute({
    getParentRoute: () => RootRoute,
    path: "/groups",
    component: GroupsPage,
});

export const GroupDetailRoute = createRoute({
    getParentRoute: () => RootRoute,
    path: "/groups/$groupId",
    component: GroupDetailPage,
});

export const rootTree = RootRoute.addChildren([
    HomeRoute,
    SettingsRoute,
    EditVideoRoute,
    NotFoundRoute,
    GamesRoute,
    GameDetailRoute,
    GroupsRoute,
    GroupDetailRoute,
]);
