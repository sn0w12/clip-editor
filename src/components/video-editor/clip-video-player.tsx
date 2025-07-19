import React, { useEffect, useRef, useState, useCallback } from "react";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import {
    Play,
    Pause,
    SkipBack,
    SkipForward,
    RepeatIcon,
    Loader2,
    AlertCircle,
    ChevronLast,
    ChevronFirst,
    Volume2,
    VolumeX,
    Maximize,
    Minimize,
} from "lucide-react";
import { getSetting, useSetting, useShortcutSetting } from "@/utils/settings";
import { Cut, TimeRange } from "@/types/video-editor";
import { cn } from "@/utils/tailwind";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { Card } from "@/components/ui/card";
import { WaveformPlaybar } from "./waveform-playbar";
import { AudioTrackSelector } from "./audio-track-selector";
import { AudioVisualizer } from "./audio-visualizer";
import { Separator } from "../ui/separator";
import { formatTime } from "@/utils/format";

// Define constants for localStorage keys
const STORAGE_KEYS = {
    VOLUME: "player-volume",
    MUTED: "player-muted",
    PLAY_SELECTED_ONLY: "player-play-selected-only",
};

interface DocumentWithFullscreen extends Document {
    webkitExitFullscreen?: () => Promise<void>;
    webkitFullscreenElement?: Element;
}

interface HTMLElementWithFullscreen extends HTMLElement {
    webkitRequestFullscreen?: () => Promise<void>;
}

interface ClipVideoPlayerProps {
    videoSrc: string;
    onTimeRangeChange: (range: TimeRange) => void;
    timeRange: TimeRange;
    duration: number;
    onAudioTracksChange?: (tracks: { index: number; label: string }[]) => void;
    cuts: Cut[];
    onCutsChange: (cuts: Cut[]) => void;
}

export function ClipVideoPlayer({
    videoSrc,
    onTimeRangeChange,
    timeRange,
    duration,
    onAudioTracksChange,
    cuts,
    onCutsChange,
}: ClipVideoPlayerProps) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const playerContainerRef = useRef<HTMLDivElement>(null);
    const [isFullScreen, setIsFullScreen] = useState(false);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [isLoading, setIsLoading] = useState(true);
    const [isAudioTrackReady, setIsAudioTrackReady] = useState(false);
    const [isMouseDown, setIsMouseDown] = useState(false);
    const mouseDownTimerRef = useRef<NodeJS.Timeout | null>(null);
    const isSpeedingUp = useRef<boolean>(false);
    // Load settings from localStorage with defaults
    const [playSelectedOnly, setPlaySelectedOnly] = useState(() => {
        const saved = localStorage.getItem(STORAGE_KEYS.PLAY_SELECTED_ONLY);
        return saved !== null ? JSON.parse(saved) : true;
    });
    const [volume, setVolume] = useState(() => {
        const saved = localStorage.getItem(STORAGE_KEYS.VOLUME);
        return saved !== null ? parseFloat(saved) : 1;
    });
    const [isMuted, setIsMuted] = useState(() => {
        const saved = localStorage.getItem(STORAGE_KEYS.MUTED);
        return saved !== null ? JSON.parse(saved) : false;
    });
    const [error, setError] = useState<string | null>(null);
    const [audioTracks, setAudioTracks] = useState<
        { index: number; label: string }[]
    >([]);
    const [selectedAudioTrack, setSelectedAudioTrack] = useState<number>(0);
    const animationFrameId = useRef<number | null>(null);
    const hideVolumeSliderTimeout = useRef<NodeJS.Timeout | null>(null);
    const audioSwitchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const pendingPlayRef = useRef<boolean>(false);
    const [showFullscreenControls, setShowFullscreenControls] = useState(false);
    const fullscreenControlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const seekIncrement = useSetting("seekIncrement") || 5;
    const sortedCutsRef = useRef<Cut[]>([]);

    useEffect(() => {
        sortedCutsRef.current = [...cuts].sort((a, b) => a.start - b.start);
    }, [cuts]);

    const updateTimeSmooth = useCallback(() => {
        const video = videoRef.current;
        if (!video) return;

        const currentVideoTime = video.currentTime;
        setCurrentTime(currentVideoTime);

        // Use binary search to find if current time falls within any cut
        const activeCut = findActiveCut(
            currentVideoTime,
            sortedCutsRef.current,
        );

        if (activeCut) {
            // Only seek if we're not already at the end of the cut
            const targetTime = activeCut.end;
            if (Math.abs(currentVideoTime - targetTime) > 0.1) {
                video.currentTime = targetTime;
                setCurrentTime(targetTime);
            }

            // Continue the animation frame immediately without waiting
            if (!video.paused) {
                animationFrameId.current =
                    requestAnimationFrame(updateTimeSmooth);
            }
            return;
        }

        if (playSelectedOnly && video.currentTime >= timeRange.end) {
            video.currentTime = timeRange.start;
            setCurrentTime(timeRange.start);
        }

        if (!video.paused) {
            animationFrameId.current = requestAnimationFrame(updateTimeSmooth);
        }
    }, [playSelectedOnly, timeRange.start, timeRange.end]);

    function findActiveCut(
        currentTime: number,
        sortedCuts: Cut[],
    ): Cut | undefined {
        let left = 0;
        let right = sortedCuts.length - 1;

        while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            const cut = sortedCuts[mid];

            if (currentTime >= cut.start && currentTime < cut.end) {
                return cut;
            } else if (currentTime < cut.start) {
                right = mid - 1;
            } else {
                left = mid + 1;
            }
        }

        return undefined;
    }

    const togglePlayPause = () => {
        const video = videoRef.current;
        if (!video || isMouseDown) return;

        if (isPlaying) {
            video.pause();
            if (animationFrameId.current) {
                cancelAnimationFrame(animationFrameId.current);
                animationFrameId.current = null;
            }
            setIsPlaying(false);
        } else {
            video
                .play()
                .then(() => {
                    setIsPlaying(true);
                    if (animationFrameId.current) {
                        cancelAnimationFrame(animationFrameId.current);
                    }
                    animationFrameId.current =
                        requestAnimationFrame(updateTimeSmooth);
                })
                .catch(() => {
                    setIsPlaying(false);
                });
        }
    };

    const showControls = useCallback(() => {
        setShowFullscreenControls(true);

        if (fullscreenControlsTimeoutRef.current) {
            clearTimeout(fullscreenControlsTimeoutRef.current);
        }

        fullscreenControlsTimeoutRef.current = setTimeout(() => {
            setShowFullscreenControls(false);
        }, 3000);
    }, []);

    const resetControlsTimer = useCallback(() => {
        if (isFullScreen) {
            showControls();
        }
    }, [isFullScreen, showControls]);

    const toggleFullScreen = useCallback(() => {
        const playerContainer =
            playerContainerRef.current as HTMLElementWithFullscreen | null;
        const doc = document as DocumentWithFullscreen;

        if (!playerContainer) return;

        if (!doc.fullscreenElement && !doc.webkitFullscreenElement) {
            if (playerContainer.requestFullscreen) {
                playerContainer.requestFullscreen();
            } else if (playerContainer.webkitRequestFullscreen) {
                playerContainer.webkitRequestFullscreen();
            }
        } else {
            if (doc.exitFullscreen) {
                doc.exitFullscreen();
            } else if (doc.webkitExitFullscreen) {
                doc.webkitExitFullscreen();
            }
        }
    }, []);
    useShortcutSetting("toggleFullscreen", toggleFullScreen);

    useEffect(() => {
        return () => {
            if (fullscreenControlsTimeoutRef.current) {
                clearTimeout(fullscreenControlsTimeoutRef.current);
            }
        };
    }, []);

    useEffect(() => {
        if (isFullScreen) {
            showControls();
        } else {
            setShowFullscreenControls(false);
            if (fullscreenControlsTimeoutRef.current) {
                clearTimeout(fullscreenControlsTimeoutRef.current);
            }
        }
    }, [isFullScreen, showControls]);

    const handleVideoLoaded = () => {
        setError(null);

        if (videoRef.current) {
            const defaultTrack = parseInt(
                getSetting("defaultAudioTrack") || "0",
                10,
            );

            if (
                videoRef.current.audioTracks &&
                videoRef.current.audioTracks.length > 0
            ) {
                const tracks = [];
                for (let i = 0; i < videoRef.current.audioTracks.length; i++) {
                    tracks.push({ index: i, label: `Track ${i + 1}` });
                }
                setAudioTracks(tracks);

                if (onAudioTracksChange) {
                    onAudioTracksChange(tracks);
                }

                setTimeout(() => {
                    handleAudioTrackChange(defaultTrack, 0);
                }, 100);
            } else {
                // If no audio tracks, still mark as ready with default track 0
                setIsAudioTrackReady(true);
            }

            if (videoRef.current) {
                videoRef.current.currentTime = timeRange.start;
                setCurrentTime(timeRange.start);
                setIsLoading(false);
            }
        }
    };

    const handleAudioTrackChange = (
        trackIndex: number,
        timeOverride: number | null = null,
    ) => {
        if (trackIndex === selectedAudioTrack && !isLoading) return;
        setSelectedAudioTrack(trackIndex);
        setIsAudioTrackReady(true);

        const video = videoRef.current;
        if (!video || !video.audioTracks) return;

        const wasPlaying = !video.paused;
        const currentTimePosition = timeOverride ?? video.currentTime;

        if (wasPlaying) {
            video.pause();
            pendingPlayRef.current = true;
        }

        const audioTracks = video.audioTracks;
        for (let i = 0; i < audioTracks.length; i++) {
            audioTracks[i].enabled = i === trackIndex;
        }

        const adjustedTime = Math.max(0, currentTimePosition + 0.01);
        video.currentTime = adjustedTime;

        setTimeout(() => {
            if (videoRef.current) {
                videoRef.current.currentTime = currentTimePosition;
            }
        }, 50);
    };

    const handleVideoError = (
        e: React.SyntheticEvent<HTMLVideoElement, Event>,
    ) => {
        setIsLoading(false);

        const videoElement = e.currentTarget;
        let errorMessage =
            "Failed to load video. The file may be corrupted or in an unsupported format.";

        if (videoElement.error) {
            if (videoElement.error.code === MediaError.MEDIA_ERR_NETWORK) {
                errorMessage =
                    "Network error while loading video. Check your connection or the file path.";
            } else if (
                videoElement.error.code === MediaError.MEDIA_ERR_DECODE
            ) {
                errorMessage =
                    "Error decoding video. The file may be corrupted or use an unsupported codec.";
            } else if (
                videoElement.error.code ===
                MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
            ) {
                errorMessage = "Video format not supported by your browser.";
            }
        }

        setError(errorMessage);
    };

    const skipForward = () => {
        const video = videoRef.current;
        if (!video) return;

        const newTime = Math.min(
            video.currentTime + Number(seekIncrement),
            duration,
        );
        video.currentTime = newTime;
        setCurrentTime(newTime);
    };

    const skipBackward = () => {
        const video = videoRef.current;
        if (!video) return;

        const newTime = Math.max(video.currentTime - Number(seekIncrement), 0);
        video.currentTime = newTime;
        setCurrentTime(newTime);
    };

    const jumpToStart = () => {
        const video = videoRef.current;
        if (!video) return;

        if (video.currentTime.toFixed(2) <= timeRange.start.toFixed(2)) {
            video.currentTime = 0;
            setCurrentTime(0);
            return;
        }

        video.currentTime = timeRange.start;
        setCurrentTime(timeRange.start);
    };

    const jumpToEnd = () => {
        const video = videoRef.current;
        if (!video) return;

        video.currentTime = timeRange.end;
        setCurrentTime(timeRange.end);
    };

    const handleVolumeChange = (value: number[]) => {
        const video = videoRef.current;
        if (!video) return;

        const newVolume = value[0];
        setVolume(newVolume);
        video.volume = newVolume;

        if (isMuted && newVolume > 0) {
            setIsMuted(false);
            video.muted = false;
        }
    };
    useShortcutSetting("volumeUp", () => {
        handleVolumeChange([Math.min(volume + 0.05, 1)]);
    });
    useShortcutSetting("volumeDown", () => {
        handleVolumeChange([Math.max(volume - 0.05, 0)]);
    });

    const toggleMute = () => {
        const video = videoRef.current;
        if (!video) return;

        const newMutedState = !isMuted;
        setIsMuted(newMutedState);
        video.muted = newMutedState;
    };
    useShortcutSetting("muteSound", toggleMute, {
        preventDefault: true,
    });

    const togglePlaySelectedOnly = () => {
        setPlaySelectedOnly((prev: boolean) => !prev);
    };

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        if (isPlaying) {
            video.pause();
            setIsPlaying(false);
        }

        setIsLoading(true);
        setIsAudioTrackReady(false);
        setCurrentTime(0);
        setError(null);

        if (animationFrameId.current) {
            cancelAnimationFrame(animationFrameId.current);
            animationFrameId.current = null;
        }

        video.playbackRate = 1.0;
        isSpeedingUp.current = false;
    }, [videoSrc]);

    // Save settings to localStorage when they change
    useEffect(() => {
        localStorage.setItem(STORAGE_KEYS.VOLUME, volume.toString());
    }, [volume]);

    useEffect(() => {
        localStorage.setItem(STORAGE_KEYS.MUTED, JSON.stringify(isMuted));
    }, [isMuted]);

    useEffect(() => {
        localStorage.setItem(
            STORAGE_KEYS.PLAY_SELECTED_ONLY,
            JSON.stringify(playSelectedOnly),
        );
    }, [playSelectedOnly]);

    useEffect(() => {
        if (!isLoading && videoRef.current) {
            videoRef.current.currentTime = timeRange.start;
            setCurrentTime(timeRange.start);
        }
    }, [timeRange]);

    useEffect(() => {
        const video = videoRef.current;

        if (isPlaying && video && !video.paused) {
            if (!animationFrameId.current) {
                animationFrameId.current =
                    requestAnimationFrame(updateTimeSmooth);
            }
        } else {
            if (animationFrameId.current) {
                cancelAnimationFrame(animationFrameId.current);
                animationFrameId.current = null;
            }
        }
    }, [isPlaying]);

    useEffect(() => {
        return () => {
            if (animationFrameId.current) {
                cancelAnimationFrame(animationFrameId.current);
            }

            if (audioSwitchTimeoutRef.current) {
                clearTimeout(audioSwitchTimeoutRef.current);
            }
        };
    }, []);

    useEffect(() => {
        if (videoRef.current) {
            videoRef.current.volume = volume;
            videoRef.current.muted = isMuted;
        }
    }, [volume, isMuted]);

    useEffect(() => {
        const handleFullScreenChange = () => {
            const doc = document as DocumentWithFullscreen;
            setIsFullScreen(
                !!(doc.fullscreenElement || doc.webkitFullscreenElement),
            );
        };

        document.addEventListener("fullscreenchange", handleFullScreenChange);
        document.addEventListener(
            "webkitfullscreenchange",
            handleFullScreenChange,
        );

        return () => {
            document.removeEventListener(
                "fullscreenchange",
                handleFullScreenChange,
            );
            document.removeEventListener(
                "webkitfullscreenchange",
                handleFullScreenChange,
            );
        };
    }, []);

    const handleTimeChange = (newTime: number) => {
        const video = videoRef.current;
        if (!video) return;

        setCurrentTime(newTime);
        video.currentTime = newTime;

        // If video is playing, we'll pause it during scrubbing
        if (!video.paused) {
            pendingPlayRef.current = true;
            video.pause();
        }

        // Clear any existing timeout to prevent multiple executions
        if (fullscreenControlsTimeoutRef.current) {
            clearTimeout(fullscreenControlsTimeoutRef.current);
        }

        // Set a timeout to clear the scrubbing state
        setTimeout(() => {
            // If we were playing before scrubbing started, resume playback
            if (pendingPlayRef.current) {
                pendingPlayRef.current = false;
                video.play().catch((error) => {
                    console.warn(
                        "Failed to resume playback after scrubbing",
                        error,
                    );
                });
            }
        }, 200);
    };

    const handleMouseDown = useCallback(() => {
        if (!isPlaying || !videoRef.current) return;

        // Clear any existing timer
        if (mouseDownTimerRef.current) {
            clearTimeout(mouseDownTimerRef.current);
        }

        // Set a delay before changing playback rate
        mouseDownTimerRef.current = setTimeout(() => {
            if (videoRef.current && isPlaying) {
                setIsMouseDown(true);
                videoRef.current.playbackRate = getSetting("holdSpeed") || 2.0;
                isSpeedingUp.current = true;
            }
        }, 300); // 300ms delay before enabling higher speed
    }, [isPlaying]);

    const handleMouseUp = useCallback(() => {
        if (!videoRef.current) return;

        setTimeout(() => {
            setIsMouseDown(false);
        }, 10); // Delay to ensure mouse up is processed after mouse down

        // Clear the timer if it hasn't triggered yet
        if (mouseDownTimerRef.current) {
            clearTimeout(mouseDownTimerRef.current);
            mouseDownTimerRef.current = null;
        }

        // Only reset playback rate without pausing
        if (isSpeedingUp.current) {
            videoRef.current.playbackRate = 1.0;
            isSpeedingUp.current = false;
        }
    }, []);

    useEffect(() => {
        // Add mouse up event listener to document to handle cases when mouse is released outside the video
        document.addEventListener("mouseup", handleMouseUp);

        return () => {
            document.removeEventListener("mouseup", handleMouseUp);
            // Clean up timer if component unmounts
            if (mouseDownTimerRef.current) {
                clearTimeout(mouseDownTimerRef.current);
            }
        };
    }, [handleMouseUp]);

    useShortcutSetting("pauseVideo", togglePlayPause);
    useShortcutSetting("skipForward", skipForward);
    useShortcutSetting("skipBackward", skipBackward);
    useShortcutSetting("skipToEnd", jumpToEnd);
    useShortcutSetting("skipToStart", jumpToStart);

    return (
        <>
            <div className="flex w-full flex-col">
                <div
                    ref={playerContainerRef}
                    className="relative aspect-video overflow-hidden rounded-md bg-black"
                    onMouseMove={resetControlsTimer}
                >
                    {isLoading && (
                        <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                            <Loader2 className="h-12 w-12 animate-spin text-white" />
                        </div>
                    )}
                    {error && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 p-4 text-center">
                            <AlertCircle className="h-12 w-12 text-red-500" />
                            <p className="mt-4 text-white">{error}</p>
                        </div>
                    )}
                    <video
                        ref={videoRef}
                        className="h-full w-full"
                        src={videoSrc}
                        onClick={togglePlayPause}
                        onMouseDown={handleMouseDown}
                        onMouseUp={handleMouseUp}
                        onDoubleClick={toggleFullScreen}
                        onEnded={() => {
                            setIsPlaying(false);
                            if (animationFrameId.current) {
                                cancelAnimationFrame(animationFrameId.current);
                                animationFrameId.current = null;
                            }
                        }}
                        onLoadedData={handleVideoLoaded}
                        onLoadStart={() => setIsLoading(true)}
                        onError={(e) => handleVideoError(e)}
                        onPlay={() => {
                            if (!animationFrameId.current) {
                                animationFrameId.current =
                                    requestAnimationFrame(updateTimeSmooth);
                            }
                        }}
                        onPause={() => {
                            if (animationFrameId.current) {
                                cancelAnimationFrame(animationFrameId.current);
                                animationFrameId.current = null;
                            }
                        }}
                        onSeeked={() => {
                            if (pendingPlayRef.current) {
                                pendingPlayRef.current = false;

                                if (audioSwitchTimeoutRef.current) {
                                    clearTimeout(audioSwitchTimeoutRef.current);
                                }

                                audioSwitchTimeoutRef.current = setTimeout(
                                    () => {
                                        if (videoRef.current) {
                                            videoRef.current
                                                .play()
                                                .catch((error) => {
                                                    console.warn(
                                                        "Failed to resume playback after seeking",
                                                        error,
                                                    );

                                                    setTimeout(() => {
                                                        if (videoRef.current) {
                                                            videoRef.current
                                                                .play()
                                                                .catch(() => {
                                                                    console.error(
                                                                        "Final attempt to resume playback failed",
                                                                    );
                                                                });
                                                        }
                                                    }, 250);
                                                });
                                        }
                                    },
                                    300,
                                );
                            }
                        }}
                        preload="auto"
                        playsInline
                        crossOrigin="anonymous"
                    />

                    {isFullScreen && (
                        <div
                            className={`pointer-events-none absolute inset-0 flex flex-col justify-between p-4 transition-opacity duration-300 ${
                                showFullscreenControls
                                    ? "opacity-100"
                                    : "opacity-0"
                            }`}
                            style={{
                                background:
                                    "linear-gradient(to top, rgba(0,0,0,0.7) 0%, transparent 30%, transparent 70%, rgba(0,0,0,0.7) 100%)",
                            }}
                        >
                            <div className="pointer-events-auto flex items-center justify-between">
                                <div className="text-lg font-medium text-white">
                                    {videoSrc
                                        .split("/")
                                        .pop()
                                        ?.split("\\")
                                        .pop() || "Video"}
                                </div>
                            </div>

                            <div className="pointer-events-auto space-y-2">
                                <div className="px-2">
                                    <Slider
                                        value={[currentTime]}
                                        min={0}
                                        max={duration}
                                        step={0.01}
                                        onValueChange={(value) => {
                                            if (videoRef.current) {
                                                videoRef.current.currentTime =
                                                    value[0];
                                                setCurrentTime(value[0]);

                                                if (!videoRef.current.paused) {
                                                    pendingPlayRef.current =
                                                        true;
                                                    videoRef.current.pause();
                                                }
                                            }
                                        }}
                                        className="h-2"
                                    />
                                </div>

                                <div className="flex items-center justify-between px-4">
                                    <div className="flex items-center gap-2 text-white">
                                        <span className="font-mono text-sm">
                                            {formatTime(currentTime, {
                                                showMilliseconds: true,
                                            })}{" "}
                                            /{" "}
                                            {formatTime(duration, {
                                                showMilliseconds: true,
                                            })}
                                        </span>
                                    </div>

                                    <div className="flex items-center space-x-2">
                                        <Tooltip>
                                            <TooltipTrigger asChild>
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    className="h-8 w-8 p-0 text-white hover:bg-white/20"
                                                    onClick={skipBackward}
                                                >
                                                    <SkipBack className="h-5 w-5" />
                                                </Button>
                                            </TooltipTrigger>
                                            <TooltipContent side="top">
                                                Skip back 5 seconds
                                            </TooltipContent>
                                        </Tooltip>

                                        <Tooltip>
                                            <TooltipTrigger asChild>
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    className="h-8 w-8 p-0 text-white hover:bg-white/20"
                                                    onClick={togglePlayPause}
                                                >
                                                    {isPlaying ? (
                                                        <Pause className="h-6 w-6" />
                                                    ) : (
                                                        <Play className="h-6 w-6" />
                                                    )}
                                                </Button>
                                            </TooltipTrigger>
                                            <TooltipContent side="top">
                                                {isPlaying ? "Pause" : "Play"}
                                            </TooltipContent>
                                        </Tooltip>

                                        <Tooltip>
                                            <TooltipTrigger asChild>
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    className="h-8 w-8 p-0 text-white hover:bg-white/20"
                                                    onClick={skipForward}
                                                >
                                                    <SkipForward className="h-5 w-5" />
                                                </Button>
                                            </TooltipTrigger>
                                            <TooltipContent side="top">
                                                Skip forward 5 seconds
                                            </TooltipContent>
                                        </Tooltip>
                                    </div>

                                    <div className="flex items-center space-x-2">
                                        <Tooltip>
                                            <TooltipTrigger asChild>
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    className="h-8 w-8 p-0 text-white hover:bg-white/20"
                                                    onClick={toggleMute}
                                                >
                                                    {isMuted || volume === 0 ? (
                                                        <VolumeX className="h-5 w-5" />
                                                    ) : (
                                                        <Volume2 className="h-5 w-5" />
                                                    )}
                                                </Button>
                                            </TooltipTrigger>
                                            <TooltipContent side="top">
                                                {isMuted ? "Unmute" : "Mute"}
                                            </TooltipContent>
                                        </Tooltip>

                                        <div className="relative w-20">
                                            <Slider
                                                value={[isMuted ? 0 : volume]}
                                                min={0}
                                                max={1}
                                                step={0.01}
                                                onValueChange={(value) =>
                                                    handleVolumeChange(value)
                                                }
                                                className="h-1.5"
                                            />
                                        </div>

                                        <Tooltip>
                                            <TooltipTrigger asChild>
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    className={cn(
                                                        "h-8 w-8 p-0 text-white hover:bg-white/20",
                                                        playSelectedOnly &&
                                                            "bg-white/30",
                                                    )}
                                                    onClick={
                                                        togglePlaySelectedOnly
                                                    }
                                                >
                                                    <RepeatIcon className="h-5 w-5" />
                                                </Button>
                                            </TooltipTrigger>
                                            <TooltipContent side="top">
                                                {playSelectedOnly
                                                    ? "Disable loop"
                                                    : "Loop selection"}
                                            </TooltipContent>
                                        </Tooltip>

                                        <Tooltip>
                                            <TooltipTrigger asChild>
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    className="h-8 w-8 p-0 text-white hover:bg-white/20"
                                                    onClick={toggleFullScreen}
                                                >
                                                    <Minimize className="h-5 w-5" />
                                                </Button>
                                            </TooltipTrigger>
                                            <TooltipContent side="top">
                                                Exit fullscreen
                                            </TooltipContent>
                                        </Tooltip>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                <div className="mt-2 space-y-2">
                    {isAudioTrackReady ? (
                        <WaveformPlaybar
                            videoPath={videoSrc}
                            currentTime={currentTime}
                            duration={duration}
                            timeRange={timeRange}
                            onTimeChange={handleTimeChange}
                            onTimeRangeChange={onTimeRangeChange}
                            audioTrack={selectedAudioTrack}
                            waveformHeight={150}
                            cuts={cuts}
                            onCutsChange={onCutsChange}
                        />
                    ) : (
                        <div className="bg-background h-10 w-full" />
                    )}

                    <div className="relative mb-0 flex justify-between text-xs">
                        <div className="flex flex-col items-start">
                            <span className="font-mono">
                                {formatTime(timeRange.start, {
                                    showMilliseconds: true,
                                })}
                            </span>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-6 w-6 p-0"
                                        onClick={jumpToStart}
                                    >
                                        <ChevronFirst className="h-4 w-4" />
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent
                                    side="bottom"
                                    keys={useSetting("skipToStart")}
                                    shortcutPosition="left"
                                >
                                    Jump to clip start
                                </TooltipContent>
                            </Tooltip>
                        </div>
                        <div className="absolute left-1/2 flex -translate-x-1/2 flex-col items-center">
                            <span className="font-mono">
                                {formatTime(currentTime, {
                                    showMilliseconds: true,
                                })}
                            </span>
                            <div className="mt-1 flex items-center space-x-1">
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-6 w-6 p-0"
                                            onClick={skipBackward}
                                        >
                                            <SkipBack className="h-4 w-4" />
                                        </Button>
                                    </TooltipTrigger>
                                    <TooltipContent
                                        side="bottom"
                                        keys={useSetting("skipBackward")}
                                        shortcutPosition="left"
                                    >
                                        Skip back {seekIncrement} seconds
                                    </TooltipContent>
                                </Tooltip>
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="h-6 w-6 p-0"
                                            onClick={togglePlayPause}
                                        >
                                            {isPlaying ? (
                                                <Pause className="h-4 w-4" />
                                            ) : (
                                                <Play className="h-4 w-4" />
                                            )}
                                        </Button>
                                    </TooltipTrigger>
                                    <TooltipContent
                                        side="bottom"
                                        keys={useSetting("pauseVideo")}
                                    >
                                        {isPlaying ? "Pause" : "Play"}
                                    </TooltipContent>
                                </Tooltip>
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-6 w-6 p-0"
                                            onClick={skipForward}
                                        >
                                            <SkipForward className="h-4 w-4" />
                                        </Button>
                                    </TooltipTrigger>
                                    <TooltipContent
                                        side="bottom"
                                        keys={useSetting("skipForward")}
                                    >
                                        Skip forward {seekIncrement} seconds
                                    </TooltipContent>
                                </Tooltip>
                            </div>
                        </div>
                        <div className="flex flex-col items-end">
                            <span className="font-mono">
                                {formatTime(timeRange.end, {
                                    showMilliseconds: true,
                                })}
                            </span>
                            <div className="flex items-center space-x-1">
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className={cn(
                                                "h-6 w-6 p-0",
                                                playSelectedOnly &&
                                                    "bg-primary text-background",
                                            )}
                                            onClick={togglePlaySelectedOnly}
                                        >
                                            <RepeatIcon className="h-4 w-4" />
                                        </Button>
                                    </TooltipTrigger>
                                    <TooltipContent side="bottom">
                                        {playSelectedOnly
                                            ? "Disable loop"
                                            : "Loop selection"}
                                    </TooltipContent>
                                </Tooltip>
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <div>
                                            <AudioTrackSelector
                                                tracks={audioTracks}
                                                selectedTrack={
                                                    selectedAudioTrack
                                                }
                                                onTrackChange={
                                                    handleAudioTrackChange
                                                }
                                            />
                                        </div>
                                    </TooltipTrigger>
                                    <TooltipContent side="bottom">
                                        Select audio track
                                    </TooltipContent>
                                </Tooltip>
                                <div className="relative">
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="volume-btn h-6 w-6 p-0"
                                                onClick={toggleMute}
                                                onMouseEnter={() => {
                                                    if (
                                                        hideVolumeSliderTimeout.current
                                                    ) {
                                                        clearTimeout(
                                                            hideVolumeSliderTimeout.current,
                                                        );
                                                    }
                                                    document
                                                        .getElementById(
                                                            "volume-slider",
                                                        )
                                                        ?.classList.add(
                                                            "visible",
                                                        );
                                                }}
                                                onMouseLeave={(e) => {
                                                    if (
                                                        !e.relatedTarget ||
                                                        !(
                                                            e.relatedTarget instanceof
                                                            Element
                                                        ) ||
                                                        !e.relatedTarget.closest(
                                                            "#volume-slider",
                                                        )
                                                    ) {
                                                        hideVolumeSliderTimeout.current =
                                                            setTimeout(() => {
                                                                document
                                                                    .getElementById(
                                                                        "volume-slider",
                                                                    )
                                                                    ?.classList.remove(
                                                                        "visible",
                                                                    );
                                                            }, 500);
                                                    }
                                                }}
                                            >
                                                {isMuted || volume === 0 ? (
                                                    <VolumeX className="h-4 w-4" />
                                                ) : (
                                                    <Volume2 className="h-4 w-4" />
                                                )}
                                            </Button>
                                        </TooltipTrigger>
                                        <TooltipContent
                                            side="bottom"
                                            keys={useSetting("muteSound")}
                                        >
                                            {isMuted ? "Unmute" : "Mute"}
                                        </TooltipContent>
                                    </Tooltip>
                                    <div
                                        id="volume-slider"
                                        className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1 -translate-x-1/2 opacity-0 transition-all"
                                        style={{
                                            width: "28px",
                                            height: "100px",
                                            transform: "translateY(-90%)",
                                        }}
                                        onMouseEnter={() => {
                                            if (
                                                hideVolumeSliderTimeout.current
                                            ) {
                                                clearTimeout(
                                                    hideVolumeSliderTimeout.current,
                                                );
                                            }
                                            document
                                                .getElementById("volume-slider")
                                                ?.classList.add("visible");
                                        }}
                                        onMouseLeave={() => {
                                            hideVolumeSliderTimeout.current =
                                                setTimeout(() => {
                                                    document
                                                        .getElementById(
                                                            "volume-slider",
                                                        )
                                                        ?.classList.remove(
                                                            "visible",
                                                        );
                                                }, 500);
                                        }}
                                    >
                                        <Card className="w-7 p-2">
                                            <Slider
                                                value={[isMuted ? 0 : volume]}
                                                orientation="vertical"
                                                min={0}
                                                max={1}
                                                step={0.01}
                                                onValueChange={(value) =>
                                                    handleVolumeChange(value)
                                                }
                                                className="h-20 w-full"
                                            />
                                        </Card>
                                    </div>
                                </div>
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-6 w-6 p-0"
                                            onClick={toggleFullScreen}
                                        >
                                            {isFullScreen ? (
                                                <Minimize className="h-4 w-4" />
                                            ) : (
                                                <Maximize className="h-4 w-4" />
                                            )}
                                        </Button>
                                    </TooltipTrigger>
                                    <TooltipContent
                                        side="bottom"
                                        keys={useSetting("toggleFullscreen")}
                                    >
                                        {isFullScreen
                                            ? "Exit fullscreen"
                                            : "Enter fullscreen"}
                                    </TooltipContent>
                                </Tooltip>
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-6 w-6 p-0"
                                            onClick={jumpToEnd}
                                        >
                                            <ChevronLast className="h-4 w-4" />
                                        </Button>
                                    </TooltipTrigger>
                                    <TooltipContent
                                        side="bottom"
                                        keys={useSetting("skipToEnd")}
                                    >
                                        Jump to clip end
                                    </TooltipContent>
                                </Tooltip>
                            </div>
                        </div>
                    </div>

                    {error && (
                        <div className="flex items-center justify-center rounded-md bg-red-500/10 p-4 text-red-500">
                            <AlertCircle className="mr-2 h-5 w-5" />
                            <span className="text-sm">{error}</span>
                        </div>
                    )}
                </div>
            </div>

            <Separator className="my-4" />

            <div className="grid h-56 grid-cols-2 gap-2 transition-none lg:h-full">
                {isAudioTrackReady ? (
                    <>
                        <AudioVisualizer
                            variant="bars"
                            color="var(--accent-positive)"
                            externalAudioRef={
                                videoRef as React.RefObject<HTMLVideoElement>
                            }
                            showPlayButton={false}
                            className="h-full border-0"
                        />
                        <AudioVisualizer
                            variant="line"
                            color="var(--accent-positive)"
                            externalAudioRef={
                                videoRef as React.RefObject<HTMLVideoElement>
                            }
                            showPlayButton={false}
                            className="h-full border-0"
                        />
                    </>
                ) : (
                    <>
                        <div className="bg-background h-full rounded-md" />
                        <div className="bg-background h-full rounded-md" />
                    </>
                )}
            </div>
        </>
    );
}
