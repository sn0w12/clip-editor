import React from "react";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { ChevronDown } from "lucide-react";
import { ExportOptions } from "@/types/video-editor";

interface ExportButtonProps {
    onExport: (options: Partial<ExportOptions>) => void;
    isExporting: boolean;
    baseOptions: Partial<ExportOptions>;
}

// Define export presets
export interface ExportPreset {
    name: string;
    description: string;
    options: Partial<ExportOptions>;
}

// Default presets - can be easily extended
const DEFAULT_PRESETS: ExportPreset[] = [
    {
        name: "Discord",
        description: "Optimized for Discord (<10MB)",
        options: {
            qualityMode: "targetSize",
            targetSize: 9, // Target 9MB to be safe
            outputFormat: "mp4",
        },
    },
    {
        name: "High Quality",
        description: "Maximum quality",
        options: {
            qualityMode: "preset",
            quality: "high",
            outputFormat: "mp4",
        },
    },
    {
        name: "Compressed",
        description: "Small file size",
        options: {
            qualityMode: "preset",
            quality: "low",
            outputFormat: "mp4",
        },
    },
    {
        name: "GIF",
        description: "Animated GIF",
        options: {
            qualityMode: "targetSize",
            targetSize: 5,
            outputFormat: "gif",
            fps: 20, // Reduce frame rate for GIFs
        },
    },
];

export function ExportButton({
    onExport,
    isExporting,
    baseOptions,
}: ExportButtonProps) {
    // Store presets in state to allow for future dynamic additions
    const [presets] = React.useState<ExportPreset[]>(DEFAULT_PRESETS);

    // Handle direct export with default settings
    const handleDirectExport = () => {
        onExport(baseOptions);
    };

    // Handle preset selection
    const handlePresetExport = (preset: ExportPreset) => {
        // Merge base options with preset options
        const mergedOptions = {
            ...baseOptions,
            ...preset.options,
        };
        onExport(mergedOptions);
    };

    return (
        <div className="flex w-full">
            <Button
                className="flex-1 justify-center rounded-r-none text-center"
                onClick={handleDirectExport}
                disabled={isExporting}
                size="lg"
            >
                {isExporting ? "Exporting..." : "Export Clip"}
            </Button>

            <DropdownMenu>
                <DropdownMenuTrigger asChild disabled={isExporting}>
                    <Button
                        size="icon"
                        className="h-11 w-11 rounded-l-none border-l"
                    >
                        <ChevronDown className="h-4 w-4" />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuItem
                        disabled
                        className="text-muted-foreground font-semibold"
                    >
                        Export Presets
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    {presets.map((preset, index) => (
                        <DropdownMenuItem
                            key={index}
                            onClick={() => handlePresetExport(preset)}
                        >
                            <div className="flex flex-col">
                                <span>{preset.name}</span>
                                <span className="text-muted-foreground text-xs">
                                    {preset.description}
                                </span>
                            </div>
                        </DropdownMenuItem>
                    ))}
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    );
}
