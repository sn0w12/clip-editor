import React from "react";
import { ErrorPage } from "@/components/error/error-page";
import { Code } from "@/components/ui/code";

export default function NotFoundPage() {
    const inDevelopment = process.env.NODE_ENV === "development";

    return (
        <ErrorPage
            code="404"
            title="Page Not Found"
            message="The page you're looking for doesn't exist or has been moved to another location."
            showDevInfo={inDevelopment}
            returnButtonText="Return to Home"
            returnPath="/"
            showRouterState={true}
            pathInfoTitle="Requested Path"
            // Providing 404-specific development content
            devContent={
                <div>
                    <h4 className="mb-1 text-xs font-semibold">
                        Missing Route
                    </h4>
                    <p className="text-muted-foreground mb-3 text-xs">
                        This 404 error indicates the current route is not
                        defined. Check your route definitions in
                        <Code
                            className="bg-muted rounded px-1"
                            variant={"inline"}
                        >
                            src/routes/routes.tsx
                        </Code>
                    </p>

                    <h4 className="mt-4 mb-1 text-xs font-semibold">
                        Common Issues:
                    </h4>
                    <ul className="text-muted-foreground list-inside list-disc space-y-1 text-xs">
                        <li>Route not registered in the route configuration</li>
                        <li>URL typo or incorrect path format</li>
                        <li>Recently removed or renamed route</li>
                        <li>Missing parent route or outlet</li>
                    </ul>
                </div>
            }
            // Additional debug info specific to 404 routing issues
            debugBlocks={[
                {
                    title: "Route Troubleshooting",
                    content: (
                        <p>
                            Check that all route segments are correct and the
                            path matches exactly what&apos;s defined in your
                            route configuration.
                        </p>
                    ),
                },
            ]}
        />
    );
}
