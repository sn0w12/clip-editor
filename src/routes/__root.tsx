import React from "react";
import BaseLayout from "@/layouts/base-layout";
import { Outlet, createRootRoute } from "@tanstack/react-router";

export const RootRoute = createRootRoute({
    component: Root,
});

function Root() {
    return (
        <BaseLayout>
            <Outlet />
        </BaseLayout>
    );
}
