import React from "react";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Headphones } from "lucide-react";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";

interface AudioTrackSelectorProps {
    tracks: { index: number; label: string }[];
    selectedTrack: number;
    onTrackChange: (trackIndex: number) => void;
    isSwitching?: boolean;
}

export function AudioTrackSelector({
    tracks,
    selectedTrack,
    onTrackChange,
    isSwitching = false,
}: AudioTrackSelectorProps) {
    const handleTrackSelect = (index: number) => {
        onTrackChange(index);
    };

    return (
        <Tooltip>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <TooltipTrigger asChild>
                        <Button
                            variant="ghost"
                            size="sm"
                            className={`h-6 w-6 p-0 ${isSwitching ? "opacity-70" : ""}`}
                            disabled={isSwitching}
                        >
                            <Headphones
                                className={`h-4 w-4 ${isSwitching ? "text-accent animate-pulse" : ""}`}
                            />
                        </Button>
                    </TooltipTrigger>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="center" side="top">
                    {tracks.map((track) => (
                        <DropdownMenuItem
                            key={track.index}
                            className={
                                selectedTrack === track.index ? "bg-muted" : ""
                            }
                            onClick={() => handleTrackSelect(track.index)}
                        >
                            Track {track.index + 1}
                        </DropdownMenuItem>
                    ))}
                </DropdownMenuContent>
            </DropdownMenu>
            <TooltipContent side="bottom">Audio Tracks</TooltipContent>
        </Tooltip>
    );
}
