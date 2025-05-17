import {
    createMemoryHistory,
    createRouter,
    createBrowserHistory,
} from "@tanstack/react-router";
import { rootTree } from "./routes";
import { platform } from "@/platform";

declare module "@tanstack/react-router" {
    interface Register {
        router: typeof router;
    }
}

const history = platform.isWeb()
    ? createBrowserHistory()
    : createMemoryHistory({
          initialEntries: ["/"],
      });

export const router = createRouter({
    routeTree: rootTree,
    history: history,
    defaultPreload: "intent",
});
