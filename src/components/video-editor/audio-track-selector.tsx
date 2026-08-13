import { Headphones } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface AudioTrackOption {
    index: number;
    label: string;
}

interface AudioTrackSelectorProps {
    tracks: AudioTrackOption[];
    selectedTrack: number;
    onTrackChange: (trackIndex: number) => void;
    isSwitching?: boolean;
}

/**
 * Dropdown menu to pick which audio track the player exposes to the
 * visualization and waveform.
 */
export function AudioTrackSelector({
    tracks,
    selectedTrack,
    onTrackChange,
    isSwitching = false,
}: AudioTrackSelectorProps) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                render={
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        className={cn("h-6 w-6 p-0", isSwitching && "opacity-70")}
                        disabled={isSwitching}
                        aria-label="Select audio track"
                    />
                }
            >
                <Headphones className={cn("h-4 w-4", isSwitching && "animate-pulse text-accent")} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center" side="top">
                {tracks.map((track) => (
                    <DropdownMenuItem
                        key={track.index}
                        className={selectedTrack === track.index ? "bg-muted" : ""}
                        onClick={() => onTrackChange(track.index)}
                    >
                        {track.label || `Track ${track.index + 1}`}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
