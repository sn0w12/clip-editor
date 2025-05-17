import React, { ReactNode } from "react";
import { useNavigate, useRouterState, useRouter } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Code } from "../ui/code";

export interface ErrorPageProps {
    /** Error code to display (e.g. 404, 500) */
    code?: string | number;
    /** Main title of the error page */
    title?: string;
    /** Descriptive message explaining the error */
    message?: string;
    /** Whether to show path info section */
    showPathInfo?: boolean;
    /** Whether to show development info section when in development mode */
    showDevInfo?: boolean;
    /** Override the return button text */
    returnButtonText?: string;
    /** Override the return path (defaults to home) */
    returnPath?: string;
    /** Custom actions to show below the main button */
    customActions?: ReactNode;
    /** Text to show in development mode header */
    devModeHeaderText?: string;
    /** Text to show in development mode subheader */
    devModeSubheaderText?: string;
    /** Custom content to show in the development information section */
    devContent?: ReactNode;
    /** Additional debug information blocks to show in dev mode */
    debugBlocks?: {
        title: string;
        content: ReactNode;
    }[];
    /** Show router state information in dev mode */
    showRouterState?: boolean;
    /** Card title for the path info section */
    pathInfoTitle?: string;
    /** Whether to show query parameters in path info */
    showQueryParams?: boolean;
}

export function ErrorPage({
    code = "Error",
    title = "Something went wrong",
    message = "An unexpected error occurred. Please try again later.",
    showPathInfo = true,
    showDevInfo = true,
    returnButtonText = "Return to Home",
    returnPath = "/",
    customActions,
    devModeHeaderText = "DEVELOPMENT MODE",
    devModeSubheaderText = "Additional debug info below",
    devContent,
    debugBlocks = [],
    showRouterState = false,
    pathInfoTitle = "Current Path",
    showQueryParams = true,
}: ErrorPageProps) {
    const navigate = useNavigate();
    const routerState = useRouterState();
    const router = useRouter();
    const inDevelopment = process.env.NODE_ENV === "development";

    // Extract path and query parameters for debugging
    const currentPath = routerState.location.pathname;
    const queryParams = Object.fromEntries(
        new URLSearchParams(routerState.location.search),
    );
    const hasQueryParams = Object.keys(queryParams).length > 0;

    return (
        <div className="flex h-full flex-col items-center justify-center p-6">
            <div className="flex flex-col items-center text-center">
                <h1 className="mb-2 text-6xl font-bold">{code}</h1>
                <h2 className="mb-6 text-2xl font-semibold">{title}</h2>
                <p className="text-muted-foreground mb-6 max-w-md">{message}</p>

                {/* Path information */}
                {showPathInfo && (
                    <Card className="mb-6 w-full max-w-md gap-2 p-4 text-left">
                        <h3 className="font-medium">{pathInfoTitle}:</h3>
                        <Code>{currentPath}</Code>

                        {showQueryParams && hasQueryParams && (
                            <>
                                <h3 className="mt-4 mb-2 font-medium">
                                    Query Parameters:
                                </h3>
                                <Code>
                                    {JSON.stringify(queryParams, null, 2)}
                                </Code>
                            </>
                        )}

                        {inDevelopment && showDevInfo && (
                            <>
                                <Separator className="my-2" />
                                <div className="flex items-center justify-between text-amber-500">
                                    <span className="text-xs font-semibold">
                                        {devModeHeaderText}
                                    </span>
                                    <span className="text-xs">
                                        {devModeSubheaderText}
                                    </span>
                                </div>

                                <ScrollArea className="mt-4 h-[180px]">
                                    <div className="space-y-4 pr-4">
                                        {/* Primary dev content */}
                                        {devContent && (
                                            <div className="text-muted-foreground text-xs">
                                                {devContent}
                                            </div>
                                        )}

                                        {/* Router state */}
                                        {showRouterState && (
                                            <div>
                                                <h4 className="mb-1 text-xs font-semibold">
                                                    Router State:
                                                </h4>
                                                <p className="text-muted-foreground text-xs">
                                                    Current location state:
                                                    <Code
                                                        className="bg-muted rounded px-1"
                                                        variant="inline"
                                                    >
                                                        {router.state.status}
                                                    </Code>
                                                </p>
                                            </div>
                                        )}

                                        {/* Custom debug blocks */}
                                        {debugBlocks.map((block, index) => (
                                            <div key={index}>
                                                <h4 className="mb-1 text-xs font-semibold">
                                                    {block.title}:
                                                </h4>
                                                <div className="text-muted-foreground text-xs">
                                                    {block.content}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </ScrollArea>
                            </>
                        )}
                    </Card>
                )}

                <div className="flex flex-col gap-4">
                    <Button onClick={() => navigate({ to: returnPath })}>
                        {returnButtonText}
                    </Button>
                    {customActions}
                </div>
            </div>
        </div>
    );
}
