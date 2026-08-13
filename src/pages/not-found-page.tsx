import { Link } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";

export function NotFoundPage(): React.ReactElement {
    return (
        <div className="flex h-full flex-col items-center justify-center gap-4">
            <p className="text-lg font-medium">Page not found</p>
            <Button render={<Link to="/" />}>Back to Clips</Button>
        </div>
    );
}
