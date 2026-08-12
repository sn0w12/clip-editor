import {
    Play,
    Pause,
    SkipBack,
    SkipForward,
    Repeat,
    Loader2,
    AlertCircle,
    ChevronLast,
    ChevronFirst,
    Volume2,
    VolumeX,
    Maximize,
    Minimize,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type * as React from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSetting, useShortcutSetting } from "@/lib/settings";
import { getPlayableVideo, videoSrc } from "@/lib/tauri";
import type { Cut, TimeRange } from "@/types";

import { AudioTrackSelector } from "./audio-track-selector";
import { WaveformPlaybar } from "./waveform-playbar";

/**
 * Legacy `@/utils/format` contract: `formatTime(seconds, { showMilliseconds })`.
 */
export function formatTime(
    timeInSeconds: number,
    options: {
        showMilliseconds?: boolean;
        showHours?: boolean;
        padZeros?: boolean;
        separator?: string;
        msSeparator?: string;
    } = {},
): string {
    const {
        showMilliseconds = false,
        showHours = false,
        padZeros = true,
        separator = ":",
        msSeparator = ".",
    } = options;

    const hours = showHours ? Math.floor(timeInSeconds / 3600) : 0;
    const minutes = Math.floor((timeInSeconds % 3600) / 60);
    const seconds = Math.floor(timeInSeconds % 60);
    const ms = Math.floor((timeInSeconds % 1) * 100);

    const pad = (num: number, size: number): string =>
        padZeros ? num.toString().padStart(size, "0") : num.toString();

    let result = "";

    if (showHours || hours > 0) {
        result += pad(hours, 2) + separator;
    }

    result += pad(minutes, 2) + separator + pad(seconds, 2);

    if (showMilliseconds) {
        result += msSeparator + pad(ms, 2);
    }

    return result;
}

const STORAGE_KEYS = {
    VOLUME: "clip-editor-volume",
    MUTED: "clip-editor-muted",
    PLAY_SELECTED_ONLY: "player-play-selected-only",
};

interface DocumentWithFullscreen extends Document {
    webkitExitFullscreen?: () => Promise<void>;
    webkitFullscreenElement?: Element;
}

interface HTMLElementWithFullscreen extends HTMLElement {
    webkitRequestFullscreen?: () => Promise<void>;
}

// Chromium exposes `HTMLMediaElement.audioTracks`; the installed TS DOM lib
// does not type it, so model the small surface we use.
interface AudioTrackLike {
    enabled: boolean;
    label: string;
}
interface AudioTrackListLike {
    readonly length: number;
    [index: number]: AudioTrackLike;
}
interface HTMLVideoElementWithTracks extends HTMLVideoElement {
    audioTracks?: AudioTrackListLike;
}

interface ClipVideoPlayerProps {
    videoSrc: string;
    onTimeRangeChange: (range: TimeRange) => void;
    timeRange: TimeRange;
    duration: number;
    onAudioTracksChange?: (tracks: { index: number; label: string }[]) => void;
    /** Tracks from the file metadata (Chromium has no `audioTracks` API). */
    audioTracks?: { index: number; label: string }[];
    cuts: Cut[];
    onCutsChange: (cuts: Cut[]) => void;
}

/** Recover the file path from a video URL: the media-server form
 * (`http://127.0.0.1:<port>/<encoded path>`) or the asset-protocol URL. */
function pathFromVideoSrc(src: string): string {
    if (!src) return "";
    const mediaPrefix = "http://127.0.0.1:";
    if (src.startsWith(mediaPrefix)) {
        const pathStart = src.indexOf("/", mediaPrefix.length);
        if (pathStart >= 0) {
            const rest = src.slice(pathStart + 1);
            try {
                return decodeURIComponent(rest);
            } catch {
                return rest;
            }
        }
        return src;
    }
    const clipPrefix = "http://clip-video.localhost/";
    if (src.startsWith(clipPrefix)) {
        const rest = src.slice(clipPrefix.length);
        try {
            return decodeURIComponent(rest);
        } catch {
            return rest;
        }
    }
    const assetPrefix = "asset.localhost/";
    const idx = src.indexOf(assetPrefix);
    if (idx >= 0) {
        const rest = src.slice(idx + assetPrefix.length);
        try {
            return decodeURIComponent(rest);
        } catch {
            return rest;
        }
    }
    return src;
}

function findActiveCut(currentTime: number, sortedCuts: Cut[]): Cut | undefined {
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

export function ClipVideoPlayer({
    videoSrc: videoSrcProp,
    onTimeRangeChange,
    timeRange,
    duration,
    onAudioTracksChange,
    audioTracks: metadataAudioTracks = [],
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
    const mouseDownTimerRef = useRef<number | null>(null);
    const isSpeedingUp = useRef<boolean>(false);
    const [playSelectedOnly, setPlaySelectedOnly] = useState(() => {
        const saved = localStorage.getItem(STORAGE_KEYS.PLAY_SELECTED_ONLY);
        try {
            return saved !== null ? (JSON.parse(saved) as boolean) : true;
        } catch {
            return true;
        }
    });
    const [volume, setVolume] = useState(() => {
        const saved = localStorage.getItem(STORAGE_KEYS.VOLUME);
        const parsed = saved !== null ? Number.parseFloat(saved) : 1;
        return Number.isFinite(parsed) ? parsed : 1;
    });
    const [isMuted, setIsMuted] = useState(() => {
        const saved = localStorage.getItem(STORAGE_KEYS.MUTED);
        try {
            return saved !== null ? (JSON.parse(saved) as boolean) : false;
        } catch {
            return false;
        }
    });
    const [error, setError] = useState<string | null>(null);
    // Tracks come from the file metadata when available; otherwise fall back to
    // Chromium's DOM `audioTracks` discovered when the video loads.
    const [domAudioTracks, setDomAudioTracks] = useState<{ index: number; label: string }[]>([]);
    const audioTracks = metadataAudioTracks.length > 0 ? metadataAudioTracks : domAudioTracks;
    const [selectedAudioTrack, setSelectedAudioTrack] = useState<number>(0);
    const animationFrameId = useRef<number | null>(null);
    const audioSwitchTimeoutRef = useRef<number | null>(null);
    const pendingPlayRef = useRef<boolean>(false);
    const [showFullscreenControls, setShowFullscreenControls] = useState(false);
    const fullscreenControlsTimeoutRef = useRef<number | null>(null);
    const [showVolumeSlider, setShowVolumeSlider] = useState(false);
    const hideVolumeSliderTimeoutRef = useRef<number | null>(null);
    const seekIncrement = Number(useSetting("seekIncrement") ?? 5);
    const holdSpeed = Number(useSetting("holdSpeed") ?? 2);
    const defaultAudioTrackSetting = useSetting<string>("defaultAudioTrack");
    const sortedCutsRef = useRef<Cut[]>([]);

    // The clip may be MKV, which WebView2 cannot demux — resolve a playable
    // container first (the original for MP4/MOV/WebM, a copy-remux for MKV) and
    // only then set the element's src. Audio tracks are switched on the same
    // file via `audioTracks.enabled`, so no per-track remux is needed.
    const basePath = pathFromVideoSrc(videoSrcProp);
    const [resolvedSrcResult, setResolvedSrcResult] = useState<{
        basePath: string;
        url: string;
    } | null>(null);
    useEffect(() => {
        if (!basePath) return;
        let cancelled = false;
        getPlayableVideo(basePath)
            .then((playable) => videoSrc(playable))
            .then((url) => {
                if (!cancelled) setResolvedSrcResult({ basePath, url });
            })
            .catch(() => {
                if (!cancelled) setResolvedSrcResult({ basePath, url: "" });
            });
        return () => {
            cancelled = true;
        };
    }, [basePath]);

    // Derived: only use a resolution that belongs to the current source, so a
    // source switch blanks the video immediately (no effect-driven reset).
    const resolvedSrc = resolvedSrcResult?.basePath === basePath ? resolvedSrcResult.url : "";

    useEffect(() => {
        sortedCutsRef.current = [...cuts].sort((a, b) => a.start - b.start);
    }, [cuts]);

    // Recursion goes through a ref so the memoized callback never references
    // itself before declaration (which would defeat compiler memoization).
    const updateTimeSmoothRef = useRef<() => void>(() => {});
    const updateTimeSmooth = useCallback(() => {
        const video = videoRef.current;
        if (!video) return;

        const currentVideoTime = video.currentTime;
        setCurrentTime(currentVideoTime);

        const activeCut = findActiveCut(currentVideoTime, sortedCutsRef.current);

        if (activeCut) {
            const targetTime = activeCut.end;
            if (Math.abs(currentVideoTime - targetTime) > 0.1) {
                video.currentTime = targetTime;
                setCurrentTime(targetTime);
            }

            if (!video.paused) {
                animationFrameId.current = requestAnimationFrame(updateTimeSmoothRef.current);
            }
            return;
        }

        if (playSelectedOnly && video.currentTime >= timeRange.end) {
            video.currentTime = timeRange.start;
            setCurrentTime(timeRange.start);
        }

        if (!video.paused) {
            animationFrameId.current = requestAnimationFrame(updateTimeSmoothRef.current);
        }
    }, [playSelectedOnly, timeRange.start, timeRange.end]);
    useEffect(() => {
        updateTimeSmoothRef.current = updateTimeSmooth;
    }, [updateTimeSmooth]);

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
                    animationFrameId.current = requestAnimationFrame(updateTimeSmooth);
                })
                .catch(() => {
                    setIsPlaying(false);
                });
        }
    };

    const showControls = useCallback(() => {
        setShowFullscreenControls(true);

        if (fullscreenControlsTimeoutRef.current) {
            window.clearTimeout(fullscreenControlsTimeoutRef.current);
        }

        fullscreenControlsTimeoutRef.current = window.setTimeout(() => {
            setShowFullscreenControls(false);
        }, 3000);
    }, []);

    const resetControlsTimer = useCallback(() => {
        if (isFullScreen) {
            showControls();
        }
    }, [isFullScreen, showControls]);

    const toggleFullScreen = useCallback(() => {
        const playerContainer = playerContainerRef.current as HTMLElementWithFullscreen | null;
        const doc = document as DocumentWithFullscreen;

        if (!playerContainer) return;

        if (!doc.fullscreenElement && !doc.webkitFullscreenElement) {
            if (playerContainer.requestFullscreen) {
                void playerContainer.requestFullscreen();
            } else if (playerContainer.webkitRequestFullscreen) {
                void playerContainer.webkitRequestFullscreen();
            }
        } else {
            if (doc.exitFullscreen) {
                void doc.exitFullscreen();
            } else if (doc.webkitExitFullscreen) {
                void doc.webkitExitFullscreen();
            }
        }
    }, []);
    useShortcutSetting("toggleFullscreen", toggleFullScreen);

    useEffect(() => {
        return () => {
            if (fullscreenControlsTimeoutRef.current) {
                window.clearTimeout(fullscreenControlsTimeoutRef.current);
            }
            if (hideVolumeSliderTimeoutRef.current) {
                window.clearTimeout(hideVolumeSliderTimeoutRef.current);
            }
        };
    }, []);

    // Keep fullscreen controls in sync with the (browser-driven) fullscreen
    // state using React's "adjust state during render" pattern.
    const [prevIsFullScreen, setPrevIsFullScreen] = useState(isFullScreen);
    if (prevIsFullScreen !== isFullScreen) {
        setPrevIsFullScreen(isFullScreen);
        setShowFullscreenControls(isFullScreen);
    }

    // Auto-hide the controls shortly after entering fullscreen.
    useEffect(() => {
        if (!isFullScreen) {
            if (fullscreenControlsTimeoutRef.current) {
                window.clearTimeout(fullscreenControlsTimeoutRef.current);
                fullscreenControlsTimeoutRef.current = null;
            }
            return;
        }
        fullscreenControlsTimeoutRef.current = window.setTimeout(() => {
            setShowFullscreenControls(false);
        }, 3000);
        return () => {
            if (fullscreenControlsTimeoutRef.current) {
                window.clearTimeout(fullscreenControlsTimeoutRef.current);
                fullscreenControlsTimeoutRef.current = null;
            }
        };
    }, [isFullScreen]);

    const defaultTrackAppliedRef = useRef(false);

    const handleAudioTrackChange = async (trackIndex: number) => {
        if (trackIndex === selectedAudioTrack) return;
        setSelectedAudioTrack(trackIndex);
        setIsAudioTrackReady(true);

        // Switch the audio track on the SAME file — no remux, no copies.
        const video = videoRef.current as HTMLVideoElementWithTracks | null;
        if (!video?.audioTracks) return;
        for (let i = 0; i < video.audioTracks.length; i++) {
            video.audioTracks[i].enabled = i === trackIndex;
        }
    };

    const handleVideoLoaded = () => {
        setError(null);

        const video = videoRef.current as HTMLVideoElementWithTracks | null;
        if (video) {
            const defaultTrack = Number.parseInt(defaultAudioTrackSetting ?? "0", 10);

            const domTracks =
                video.audioTracks && video.audioTracks.length > 0
                    ? Array.from({ length: video.audioTracks.length }, (_, i) => ({
                          index: i,
                          label: `Track ${i + 1}`,
                      }))
                    : null;
            const tracks =
                metadataAudioTracks && metadataAudioTracks.length > 0
                    ? metadataAudioTracks
                    : domTracks;
            if (tracks) {
                setDomAudioTracks(tracks);
                if (onAudioTracksChange) {
                    onAudioTracksChange(tracks);
                }
                // Apply the default track once — via `audioTracks.enabled`, on
                // the same file (no reload).
                if (!defaultTrackAppliedRef.current) {
                    defaultTrackAppliedRef.current = true;
                    const at = video.audioTracks;
                    if (at && at.length > 0 && defaultTrack < at.length) {
                        for (let i = 0; i < at.length; i++) {
                            at[i].enabled = i === defaultTrack;
                        }
                        setSelectedAudioTrack(defaultTrack);
                    }
                }
                setIsAudioTrackReady(true);
            } else {
                setIsAudioTrackReady(true);
            }

            video.currentTime = timeRange.start;
            setCurrentTime(timeRange.start);
            setIsLoading(false);
        }
    };

    const handleVideoError = (e: React.SyntheticEvent<HTMLVideoElement, Event>) => {
        setIsLoading(false);

        const videoElement = e.currentTarget;
        let errorMessage =
            "Failed to load video. The file may be corrupted or in an unsupported format.";

        if (videoElement.error) {
            if (videoElement.error.code === MediaError.MEDIA_ERR_NETWORK) {
                errorMessage =
                    "Network error while loading video. Check your connection or the file path.";
            } else if (videoElement.error.code === MediaError.MEDIA_ERR_DECODE) {
                errorMessage =
                    "Error decoding video. The file may be corrupted or use an unsupported codec.";
            } else if (videoElement.error.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
                errorMessage = "Video format not supported by your browser.";
            }
        }

        setError(errorMessage);
    };

    const skipForward = () => {
        const video = videoRef.current;
        if (!video) return;

        const newTime = Math.min(video.currentTime + seekIncrement, duration);
        video.currentTime = newTime;
        setCurrentTime(newTime);
    };

    const skipBackward = () => {
        const video = videoRef.current;
        if (!video) return;

        const newTime = Math.max(video.currentTime - seekIncrement, 0);
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

    const handleVolumeChange = (value: number | readonly number[]) => {
        const video = videoRef.current;
        if (!video) return;

        const newVolume = Array.isArray(value) ? value[0] : value;
        setVolume(newVolume);
        video.volume = newVolume;

        if (isMuted && newVolume > 0) {
            setIsMuted(false);
            video.muted = false;
        }
    };

    const toggleMute = () => {
        const video = videoRef.current;
        if (!video) return;

        const newMutedState = !isMuted;
        setIsMuted(newMutedState);
        video.muted = newMutedState;
    };
    useShortcutSetting("muteSound", toggleMute);

    const togglePlaySelectedOnly = () => {
        setPlaySelectedOnly((prev) => !prev);
    };

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        video.pause();
        setIsPlaying(false);

        setIsLoading(true);
        setIsAudioTrackReady(false);
        setCurrentTime(0);
        setError(null);
        setSelectedAudioTrack(0);
        defaultTrackAppliedRef.current = false;

        if (animationFrameId.current) {
            cancelAnimationFrame(animationFrameId.current);
            animationFrameId.current = null;
        }

        video.playbackRate = 1.0;
        isSpeedingUp.current = false;
    }, [videoSrcProp]);

    useEffect(() => {
        localStorage.setItem(STORAGE_KEYS.VOLUME, volume.toString());
    }, [volume]);

    useEffect(() => {
        localStorage.setItem(STORAGE_KEYS.MUTED, JSON.stringify(isMuted));
    }, [isMuted]);

    useEffect(() => {
        localStorage.setItem(STORAGE_KEYS.PLAY_SELECTED_ONLY, JSON.stringify(playSelectedOnly));
    }, [playSelectedOnly]);

    useEffect(() => {
        if (!isLoading && videoRef.current) {
            videoRef.current.currentTime = timeRange.start;
            setCurrentTime(timeRange.start);
        }
    }, [timeRange, isLoading]);

    useEffect(() => {
        const video = videoRef.current;

        if (isPlaying && video && !video.paused) {
            if (!animationFrameId.current) {
                animationFrameId.current = requestAnimationFrame(updateTimeSmooth);
            }
        } else {
            if (animationFrameId.current) {
                cancelAnimationFrame(animationFrameId.current);
                animationFrameId.current = null;
            }
        }
    }, [isPlaying, updateTimeSmooth]);

    useEffect(() => {
        return () => {
            if (animationFrameId.current) {
                cancelAnimationFrame(animationFrameId.current);
            }

            if (audioSwitchTimeoutRef.current) {
                window.clearTimeout(audioSwitchTimeoutRef.current);
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
            setIsFullScreen(!!(doc.fullscreenElement || doc.webkitFullscreenElement));
        };

        document.addEventListener("fullscreenchange", handleFullScreenChange);
        document.addEventListener("webkitfullscreenchange", handleFullScreenChange);

        return () => {
            document.removeEventListener("fullscreenchange", handleFullScreenChange);
            document.removeEventListener("webkitfullscreenchange", handleFullScreenChange);
        };
    }, []);

    const handleTimeChange = (newTime: number) => {
        const video = videoRef.current;
        if (!video) return;

        setCurrentTime(newTime);
        video.currentTime = newTime;

        if (!video.paused) {
            pendingPlayRef.current = true;
            video.pause();
        }

        window.setTimeout(() => {
            if (pendingPlayRef.current) {
                pendingPlayRef.current = false;
                video.play().catch((playError) => {
                    console.warn("Failed to resume playback after scrubbing", playError);
                });
            }
        }, 200);
    };

    const handleMouseDown = useCallback(() => {
        if (!isPlaying || !videoRef.current) return;

        if (mouseDownTimerRef.current) {
            window.clearTimeout(mouseDownTimerRef.current);
        }

        mouseDownTimerRef.current = window.setTimeout(() => {
            if (videoRef.current && isPlaying) {
                setIsMouseDown(true);
                videoRef.current.playbackRate = holdSpeed;
                isSpeedingUp.current = true;
            }
        }, 300);
    }, [isPlaying, holdSpeed]);

    const handleMouseUp = useCallback(() => {
        if (!videoRef.current) return;

        window.setTimeout(() => {
            setIsMouseDown(false);
        }, 10);

        if (mouseDownTimerRef.current) {
            window.clearTimeout(mouseDownTimerRef.current);
            mouseDownTimerRef.current = null;
        }

        if (isSpeedingUp.current) {
            videoRef.current.playbackRate = 1.0;
            isSpeedingUp.current = false;
        }
    }, []);

    useEffect(() => {
        document.addEventListener("mouseup", handleMouseUp);

        return () => {
            document.removeEventListener("mouseup", handleMouseUp);
            if (mouseDownTimerRef.current) {
                window.clearTimeout(mouseDownTimerRef.current);
            }
        };
    }, [handleMouseUp]);

    useShortcutSetting("pauseVideo", togglePlayPause);
    useShortcutSetting("skipForward", skipForward);
    useShortcutSetting("skipBackward", skipBackward);
    useShortcutSetting("skipToEnd", jumpToEnd);
    useShortcutSetting("skipToStart", jumpToStart);

    const waveformPath = pathFromVideoSrc(videoSrcProp);

    return (
        <>
            <div className="flex h-full w-full flex-col">
                <div className="min-h-0 flex-1">
                    <div
                        ref={playerContainerRef}
                        className="relative h-full overflow-hidden rounded-md bg-black"
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
                            className="h-full w-full object-contain"
                            src={resolvedSrc}
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
                                        window.clearTimeout(audioSwitchTimeoutRef.current);
                                    }

                                    audioSwitchTimeoutRef.current = window.setTimeout(() => {
                                        if (videoRef.current) {
                                            videoRef.current.play().catch(() => {
                                                window.setTimeout(() => {
                                                    videoRef.current?.play().catch(() => {
                                                        console.error(
                                                            "Final attempt to resume playback failed",
                                                        );
                                                    });
                                                }, 250);
                                            });
                                        }
                                    }, 300);
                                }
                            }}
                            preload="auto"
                            playsInline
                        />

                        {isFullScreen && (
                            <div
                                className={`pointer-events-none absolute inset-0 flex flex-col justify-between p-4 transition-opacity duration-300 ${
                                    showFullscreenControls ? "opacity-100" : "opacity-0"
                                }`}
                                style={{
                                    background:
                                        "linear-gradient(to top, rgba(0,0,0,0.7) 0%, transparent 30%, transparent 70%, rgba(0,0,0,0.7) 100%)",
                                }}
                            >
                                <div className="pointer-events-auto flex items-center justify-between">
                                    <div className="text-lg font-medium text-white">
                                        {videoSrcProp.split("/").pop()?.split("\\").pop() ||
                                            "Video"}
                                    </div>
                                </div>

                                <div className="pointer-events-auto space-y-2">
                                    <div className="px-2">
                                        <Slider
                                            value={[currentTime]}
                                            min={0}
                                            max={Math.max(0.1, duration)}
                                            step={0.01}
                                            onValueChange={(value) => {
                                                if (videoRef.current) {
                                                    const newTime = Array.isArray(value)
                                                        ? value[0]
                                                        : value;
                                                    videoRef.current.currentTime = newTime;
                                                    setCurrentTime(newTime);

                                                    if (!videoRef.current.paused) {
                                                        pendingPlayRef.current = true;
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
                                                <TooltipTrigger
                                                    render={
                                                        <Button
                                                            variant="ghost"
                                                            size="icon-sm"
                                                            className="h-8 w-8 p-0 text-white hover:bg-white/20"
                                                            onClick={skipBackward}
                                                        />
                                                    }
                                                >
                                                    <SkipBack className="h-5 w-5" />
                                                </TooltipTrigger>
                                                <TooltipContent side="top">
                                                    Skip back {seekIncrement} seconds
                                                </TooltipContent>
                                            </Tooltip>

                                            <Tooltip>
                                                <TooltipTrigger
                                                    render={
                                                        <Button
                                                            variant="ghost"
                                                            size="icon-sm"
                                                            className="h-8 w-8 p-0 text-white hover:bg-white/20"
                                                            onClick={togglePlayPause}
                                                        />
                                                    }
                                                >
                                                    {isPlaying ? (
                                                        <Pause className="h-6 w-6" />
                                                    ) : (
                                                        <Play className="h-6 w-6" />
                                                    )}
                                                </TooltipTrigger>
                                                <TooltipContent side="top">
                                                    {isPlaying ? "Pause" : "Play"}
                                                </TooltipContent>
                                            </Tooltip>

                                            <Tooltip>
                                                <TooltipTrigger
                                                    render={
                                                        <Button
                                                            variant="ghost"
                                                            size="icon-sm"
                                                            className="h-8 w-8 p-0 text-white hover:bg-white/20"
                                                            onClick={skipForward}
                                                        />
                                                    }
                                                >
                                                    <SkipForward className="h-5 w-5" />
                                                </TooltipTrigger>
                                                <TooltipContent side="top">
                                                    Skip forward {seekIncrement} seconds
                                                </TooltipContent>
                                            </Tooltip>
                                        </div>

                                        <div className="flex items-center space-x-2">
                                            <Tooltip>
                                                <TooltipTrigger
                                                    render={
                                                        <Button
                                                            variant="ghost"
                                                            size="icon-sm"
                                                            className="h-8 w-8 p-0 text-white hover:bg-white/20"
                                                            onClick={toggleMute}
                                                        />
                                                    }
                                                >
                                                    {isMuted || volume === 0 ? (
                                                        <VolumeX className="h-5 w-5" />
                                                    ) : (
                                                        <Volume2 className="h-5 w-5" />
                                                    )}
                                                </TooltipTrigger>
                                                <TooltipContent side="top">
                                                    {isMuted ? "Unmute" : "Mute"}
                                                </TooltipContent>
                                            </Tooltip>

                                            <Slider
                                                value={[isMuted ? 0 : volume]}
                                                min={0}
                                                max={1}
                                                step={0.01}
                                                onValueChange={(value) => handleVolumeChange(value)}
                                                className="h-1.5 w-20"
                                            />

                                            <Tooltip>
                                                <TooltipTrigger
                                                    render={
                                                        <Button
                                                            variant={
                                                                playSelectedOnly
                                                                    ? "default"
                                                                    : "ghost"
                                                            }
                                                            size="icon-sm"
                                                            className="h-8 w-8 p-0"
                                                            onClick={togglePlaySelectedOnly}
                                                        />
                                                    }
                                                >
                                                    <Repeat className="h-5 w-5" />
                                                </TooltipTrigger>
                                                <TooltipContent side="top">
                                                    {playSelectedOnly
                                                        ? "Disable loop"
                                                        : "Loop selection"}
                                                </TooltipContent>
                                            </Tooltip>

                                            <Tooltip>
                                                <TooltipTrigger
                                                    render={
                                                        <Button
                                                            variant="ghost"
                                                            size="icon-sm"
                                                            className="h-8 w-8 p-0"
                                                            onClick={toggleFullScreen}
                                                        />
                                                    }
                                                >
                                                    <Minimize className="h-5 w-5" />
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
                </div>

                <div className="mt-2 space-y-2">
                    {isAudioTrackReady ? (
                        <WaveformPlaybar
                            videoPath={waveformPath}
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
                                <TooltipTrigger
                                    render={
                                        <Button
                                            variant="ghost"
                                            size="icon-sm"
                                            className="h-6 w-6 p-0"
                                            onClick={jumpToStart}
                                        />
                                    }
                                >
                                    <ChevronFirst className="h-4 w-4" />
                                </TooltipTrigger>
                                <TooltipContent side="bottom">Jump to clip start</TooltipContent>
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
                                    <TooltipTrigger
                                        render={
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                className="h-6 w-6 p-0"
                                                onClick={skipBackward}
                                            />
                                        }
                                    >
                                        <SkipBack className="h-4 w-4" />
                                    </TooltipTrigger>
                                    <TooltipContent side="bottom">
                                        Skip back {seekIncrement} seconds
                                    </TooltipContent>
                                </Tooltip>
                                <Tooltip>
                                    <TooltipTrigger
                                        render={
                                            <Button
                                                variant="outline"
                                                size="icon-sm"
                                                className="h-6 w-6 p-0"
                                                onClick={togglePlayPause}
                                            />
                                        }
                                    >
                                        {isPlaying ? (
                                            <Pause className="h-4 w-4" />
                                        ) : (
                                            <Play className="h-4 w-4" />
                                        )}
                                    </TooltipTrigger>
                                    <TooltipContent side="bottom">
                                        {isPlaying ? "Pause" : "Play"}
                                    </TooltipContent>
                                </Tooltip>
                                <Tooltip>
                                    <TooltipTrigger
                                        render={
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                className="h-6 w-6 p-0"
                                                onClick={skipForward}
                                            />
                                        }
                                    >
                                        <SkipForward className="h-4 w-4" />
                                    </TooltipTrigger>
                                    <TooltipContent side="bottom">
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
                                    <TooltipTrigger
                                        render={
                                            <Button
                                                variant={playSelectedOnly ? "default" : "ghost"}
                                                size="icon-sm"
                                                className="h-6 w-6 p-0"
                                                onClick={togglePlaySelectedOnly}
                                            />
                                        }
                                    >
                                        <Repeat className="h-4 w-4" />
                                    </TooltipTrigger>
                                    <TooltipContent side="bottom">
                                        {playSelectedOnly ? "Disable loop" : "Loop selection"}
                                    </TooltipContent>
                                </Tooltip>
                                <AudioTrackSelector
                                    tracks={audioTracks}
                                    selectedTrack={selectedAudioTrack}
                                    onTrackChange={handleAudioTrackChange}
                                />
                                <Popover open={showVolumeSlider} onOpenChange={setShowVolumeSlider}>
                                    <PopoverTrigger
                                        render={
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                className="h-6 w-6 p-0"
                                                onClick={toggleMute}
                                                onMouseEnter={() => {
                                                    if (hideVolumeSliderTimeoutRef.current) {
                                                        window.clearTimeout(
                                                            hideVolumeSliderTimeoutRef.current,
                                                        );
                                                    }
                                                    setShowVolumeSlider(true);
                                                }}
                                                onMouseLeave={() => {
                                                    hideVolumeSliderTimeoutRef.current =
                                                        window.setTimeout(
                                                            () => setShowVolumeSlider(false),
                                                            500,
                                                        );
                                                }}
                                                aria-label={isMuted ? "Unmute" : "Mute"}
                                            />
                                        }
                                    >
                                        {isMuted || volume === 0 ? (
                                            <VolumeX className="h-4 w-4" />
                                        ) : (
                                            <Volume2 className="h-4 w-4" />
                                        )}
                                    </PopoverTrigger>
                                    <PopoverContent
                                        align="center"
                                        side="top"
                                        className="w-5.5"
                                        viewportClassName="py-1"
                                        onMouseEnter={() => {
                                            if (hideVolumeSliderTimeoutRef.current) {
                                                window.clearTimeout(
                                                    hideVolumeSliderTimeoutRef.current,
                                                );
                                            }
                                        }}
                                        onMouseLeave={() => {
                                            hideVolumeSliderTimeoutRef.current = window.setTimeout(
                                                () => setShowVolumeSlider(false),
                                                500,
                                            );
                                        }}
                                    >
                                        <Slider
                                            value={[isMuted ? 0 : volume]}
                                            orientation="vertical"
                                            min={0}
                                            max={1}
                                            step={0.01}
                                            onValueChange={(value) => handleVolumeChange(value)}
                                        />
                                    </PopoverContent>
                                </Popover>
                                <Tooltip>
                                    <TooltipTrigger
                                        render={
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                className="h-6 w-6 p-0"
                                                onClick={toggleFullScreen}
                                            />
                                        }
                                    >
                                        {isFullScreen ? (
                                            <Minimize className="h-4 w-4" />
                                        ) : (
                                            <Maximize className="h-4 w-4" />
                                        )}
                                    </TooltipTrigger>
                                    <TooltipContent side="bottom">
                                        {isFullScreen ? "Exit fullscreen" : "Enter fullscreen"}
                                    </TooltipContent>
                                </Tooltip>
                                <Tooltip>
                                    <TooltipTrigger
                                        render={
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                className="h-6 w-6 p-0"
                                                onClick={jumpToEnd}
                                            />
                                        }
                                    >
                                        <ChevronLast className="h-4 w-4" />
                                    </TooltipTrigger>
                                    <TooltipContent side="bottom">Jump to clip end</TooltipContent>
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
        </>
    );
}
