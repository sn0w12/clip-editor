import { Button } from "@/components/ui/button";
import { FolderOpen } from "lucide-react";
import React from "react";

interface DirectorySelectorProps {
    onSelectDirectory: () => Promise<void>;
    isLoading: boolean;
}

/**
 * Component that displays a UI for selecting a video directory
 */
export function DirectorySelector({
    onSelectDirectory,
    isLoading,
}: DirectorySelectorProps) {
    return (
        <div className="flex h-full w-full flex-col items-center justify-center p-8">
            <h1 className="mb-6 text-4xl">Video Clip Editor</h1>
            <p className="text-muted-foreground mb-8 text-center">
                Select a directory containing video files to begin editing
                clips.
            </p>
            <Button
                onClick={onSelectDirectory}
                disabled={isLoading}
                size="lg"
                className="gap-2"
            >
                <FolderOpen size={20} />
                Select Video Directory
            </Button>
        </div>
    );
}
