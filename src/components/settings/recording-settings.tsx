import {
    FolderOpenIcon,
    KeyRoundIcon,
    PlusIcon,
    TrashIcon,
    XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type * as React from "react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
    FrameDescription,
    FrameFooter,
    FrameHeader,
    FramePanel,
    FrameTitle,
} from "@/components/ui/frame";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import { setSetting as persistSetting, useSetting } from "@/lib/settings";
import { getLibraryRoots, selectFile } from "@/lib/tauri";
import { displayPath } from "@/lib/utils";
import { useRecordingStore } from "@/stores/recording-store";
import type {
    AudioProcessConfig,
    AudioTrackConfig,
    RecordingProfile,
} from "@/types";

const CODEC_OPTIONS = [
    { label: "Auto (best available)", value: "auto" },
    { label: "H.264 NVENC (NVIDIA)", value: "h264_nvenc" },
    { label: "H.264 AMF (AMD)", value: "h264_amf" },
    { label: "H.264 QSV (Intel)", value: "h264_qsv" },
    { label: "libx264 (software)", value: "libx264" },
];

const SAMPLE_RATE_OPTIONS = [
    { label: "44100 Hz", value: "44100" },
    { label: "48000 Hz", value: "48000" },
];

const CHANNEL_OPTIONS = [
    { label: "Mono", value: "1" },
    { label: "Stereo", value: "2" },
];

const BASE_SELECTORS = ["all_processes", "all_nonmuted_processes"];

const SELECTOR_BADGE_CLASS =
    "h-9 min-w-6.5 gap-1 rounded-lg px-[calc(--spacing(3)-1px)] pr-2 font-mono text-xs sm:h-8";

function SettingsPanel({
    title,
    description,
    children,
}: {
    title: string;
    description?: string;
    children: React.ReactNode;
}): React.ReactElement {
    return (
        <FramePanel className="p-0">
            <FrameHeader>
                <FrameTitle>{title}</FrameTitle>
                {description && (
                    <FrameDescription>{description}</FrameDescription>
                )}
            </FrameHeader>
            <div className="px-5 pb-5">{children}</div>
        </FramePanel>
    );
}

function SettingGrid({ children }: { children: React.ReactNode }) {
    return (
        <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
            {children}
        </div>
    );
}

function SettingEntry({
    label,
    description,
    children,
}: {
    label: string;
    description?: string;
    children: React.ReactNode;
}) {
    return (
        <div className="space-y-2">
            <div className="flex flex-col space-y-1">
                <Label className="font-medium">{label}</Label>
                {description && (
                    <p className="text-xs text-muted-foreground">
                        {description}
                    </p>
                )}
            </div>
            <div className="mt-1">{children}</div>
        </div>
    );
}

export function RecordingSettings() {
    const {
        error: recordingError,
        running,
        saving: isBufferSaving,
        save: saveBuffer,
        stop,
        start,
        getProfileSync,
        setProfile: saveProfile,
    } = useRecordingStore();
    const storeProfile = getProfileSync();
    const [draft, setDraft] = useState<RecordingProfile | null>(null);
    const profile = draft ?? storeProfile;
    const [saving, setSaving] = useState(false);
    const startReplayBufferOnStartup = useSetting<boolean>(
        "startReplayBufferOnStartup"
    );
    const [saveDir, setSaveDir] = useState<string | null>(null);
    useEffect(() => {
        let alive = true;
        void getLibraryRoots().then((roots) => {
            if (alive) setSaveDir(roots[0] ?? null);
        });
        return () => {
            alive = false;
        };
    }, []);

    const isFirstRender = useRef(true);
    useEffect(() => {
        if (isFirstRender.current) {
            isFirstRender.current = false;
            return;
        }
        if (!draft) return;
        const timer = window.setTimeout(() => {
            void saveProfile(draft).catch(() => {});
        }, 800);
        return () => window.clearTimeout(timer);
    }, [draft, saveProfile]);

    const update = (patch: Partial<RecordingProfile>) =>
        setDraft((prev) => ({ ...(prev ?? storeProfile), ...patch }));

    const save = async () => {
        setSaving(true);
        try {
            await toastManager
                .promise(saveProfile(profile), {
                    loading: { title: "Saving recording profile…" },
                    success: { title: "Recording profile saved" },
                    error: (e) => ({
                        title: `Failed to save profile: ${String(e)}`,
                    }),
                })
                .catch(() => {});
        } finally {
            setSaving(false);
        }
    };

    const browseSound = async (key: "saveIntentSound" | "successSound") => {
        const file = await selectFile();
        if (file) update({ [key]: file });
    };

    return (
        <>
            {recordingError && (
                <Alert variant="warning">{recordingError}</Alert>
            )}
            <FramePanel className="p-0">
                <div className="flex flex-row items-center justify-between px-5 py-4">
                    <FrameTitle>Buffer</FrameTitle>
                    <div className="flex items-center gap-2 text-sm">
                        {running ? (
                            <>
                                <Button
                                    size="sm"
                                    variant="info"
                                    disabled={isBufferSaving}
                                    onClick={() => void saveBuffer()}
                                >
                                    Save Clip Now
                                </Button>
                                <Button
                                    size="sm"
                                    variant="destructive-outline"
                                    onClick={() => void stop()}
                                >
                                    Stop
                                </Button>
                            </>
                        ) : (
                            <Button
                                size="sm"
                                variant="info"
                                onClick={() => {
                                    void toastManager
                                        .promise(start(), {
                                            loading: {
                                                title: "Starting replay buffer…",
                                            },
                                            success: {
                                                title: "Replay buffer started",
                                            },
                                            error: (e) => ({
                                                title: `Failed to start: ${String(e)}`,
                                            }),
                                        })
                                        .catch(() => {});
                                }}
                            >
                                Start buffer
                            </Button>
                        )}
                    </div>
                </div>
                <div className="space-y-4 px-5 pb-5">
                    <SettingEntry
                        label="Start replay buffer on startup"
                        description="With launch-on-startup enabled, the buffer begins at sign-in."
                    >
                        <Switch
                            checked={startReplayBufferOnStartup ?? true}
                            onCheckedChange={(v) =>
                                void persistSetting(
                                    "startReplayBufferOnStartup",
                                    v
                                )
                            }
                        />
                    </SettingEntry>
                    <SettingEntry
                        label={`Buffer duration: ${profile.durationSeconds}s`}
                    >
                        <Slider
                            value={[profile.durationSeconds]}
                            min={3}
                            max={300}
                            step={1}
                            onValueChange={(v) =>
                                update({
                                    durationSeconds: (Array.isArray(v)
                                        ? v
                                        : [v])[0],
                                })
                            }
                        />
                    </SettingEntry>
                    <SettingEntry
                        label={`Segment length: ${profile.segmentSeconds}s`}
                    >
                        <Slider
                            value={[profile.segmentSeconds]}
                            min={1}
                            max={10}
                            step={1}
                            onValueChange={(v) =>
                                update({
                                    segmentSeconds: (Array.isArray(v)
                                        ? v
                                        : [v])[0],
                                })
                            }
                        />
                    </SettingEntry>
                </div>
            </FramePanel>

            <SettingsPanel
                title="Capture"
                description="How the replay buffer records your screen."
            >
                <SettingGrid>
                    <SettingEntry label="Monitor">
                        <Select
                            value={profile.monitor}
                            items={[
                                {
                                    label: "Primary monitor",
                                    value: "primary",
                                },
                            ]}
                            onValueChange={(v) => {
                                if (typeof v === "string")
                                    update({ monitor: v });
                            }}
                        >
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="primary">
                                    Primary monitor
                                </SelectItem>
                            </SelectContent>
                        </Select>
                    </SettingEntry>
                    <SettingEntry label={`FPS: ${profile.fps}`}>
                        <Slider
                            value={[profile.fps]}
                            min={30}
                            max={240}
                            step={30}
                            onValueChange={(v) =>
                                update({
                                    fps: (Array.isArray(v) ? v : [v])[0],
                                })
                            }
                        />
                    </SettingEntry>
                    <SettingEntry label="Video codec">
                        <Select
                            value={profile.codec}
                            items={CODEC_OPTIONS}
                            onValueChange={(v) => {
                                if (typeof v === "string") update({ codec: v });
                            }}
                        >
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {CODEC_OPTIONS.map((c) => (
                                    <SelectItem key={c.value} value={c.value}>
                                        {c.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </SettingEntry>
                    <SettingEntry label={`Quality: ${profile.quality}`}>
                        <Slider
                            value={[profile.quality]}
                            min={0}
                            max={51}
                            step={1}
                            onValueChange={(v) =>
                                update({
                                    quality: (Array.isArray(v) ? v : [v])[0],
                                })
                            }
                        />
                    </SettingEntry>
                    <SettingEntry label="Capture cursor">
                        <Switch
                            checked={profile.cursor}
                            onCheckedChange={(v) => update({ cursor: v })}
                        />
                    </SettingEntry>
                    <SettingEntry label="Sample rate">
                        <Select
                            value={String(profile.sampleRate)}
                            items={SAMPLE_RATE_OPTIONS}
                            onValueChange={(v) => {
                                if (typeof v === "string")
                                    update({ sampleRate: Number(v) });
                            }}
                        >
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {SAMPLE_RATE_OPTIONS.map((r) => (
                                    <SelectItem key={r.value} value={r.value}>
                                        {r.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </SettingEntry>
                    <SettingEntry label="Channels">
                        <Select
                            value={String(profile.channels)}
                            items={CHANNEL_OPTIONS}
                            onValueChange={(v) => {
                                if (typeof v === "string")
                                    update({ channels: Number(v) });
                            }}
                        >
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {CHANNEL_OPTIONS.map((c) => (
                                    <SelectItem key={c.value} value={c.value}>
                                        {c.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </SettingEntry>
                </SettingGrid>
            </SettingsPanel>

            <SettingsPanel
                title="Audio routing"
                description="Per-application and per-track audio routing."
            >
                <div className="space-y-6">
                    <ProcessesEditor
                        processes={profile.processes}
                        onChange={(processes) =>
                            update({ processes, audioRouting: "all" })
                        }
                    />
                    <Separator />
                    <TracksEditor
                        tracks={profile.tracks}
                        processes={profile.processes}
                        onChange={(tracks) =>
                            update({ tracks, audioRouting: "all" })
                        }
                    />
                </div>
            </SettingsPanel>

            <SettingsPanel
                title="Save"
                description="How clips are saved from the replay buffer."
            >
                <div className="space-y-4">
                    <SettingEntry
                        label="Global save hotkey"
                        description="Saves the newest buffer window from any app."
                    >
                        <HotkeyRecorder
                            value={profile.hotkey}
                            onChange={(v) => update({ hotkey: v })}
                        />
                    </SettingEntry>
                    <SettingEntry
                        label="Save location"
                        description="Clips save into the directory you browse to in the library, with no separate output directory."
                    >
                        <Input
                            value={displayPath(saveDir ?? profile.outputDir)}
                            readOnly
                            className="font-mono text-xs"
                        />
                    </SettingEntry>
                    <SettingEntry
                        label="Sound when a save starts"
                        description="Optional WAV played as soon as a save begins, so a hotkey press has feedback while the clip is still being written."
                    >
                        <div className="flex gap-2">
                            <Input
                                value={displayPath(profile.saveIntentSound)}
                                readOnly
                                placeholder="None"
                                className="font-mono text-xs"
                            />
                            <Button
                                variant="outline"
                                onClick={() =>
                                    void browseSound("saveIntentSound")
                                }
                            >
                                <FolderOpenIcon /> Browse
                            </Button>
                            {profile.saveIntentSound && (
                                <Button
                                    variant="ghost"
                                    aria-label="Clear sound when a save starts"
                                    onClick={() =>
                                        update({ saveIntentSound: "" })
                                    }
                                >
                                    <XIcon />
                                </Button>
                            )}
                        </div>
                    </SettingEntry>
                    <SettingEntry
                        label="Sound on save"
                        description="Optional WAV played after a successful save."
                    >
                        <div className="flex gap-2">
                            <Input
                                value={displayPath(profile.successSound)}
                                readOnly
                                placeholder="None"
                                className="font-mono text-xs"
                            />
                            <Button
                                variant="outline"
                                onClick={() => void browseSound("successSound")}
                            >
                                <FolderOpenIcon /> Browse
                            </Button>
                            {profile.successSound && (
                                <Button
                                    variant="ghost"
                                    aria-label="Clear sound on save"
                                    onClick={() => update({ successSound: "" })}
                                >
                                    <XIcon />
                                </Button>
                            )}
                        </div>
                    </SettingEntry>
                </div>
            </SettingsPanel>

            <FrameFooter className="flex justify-end">
                <Button onClick={() => void save()} disabled={saving}>
                    {saving ? "Saving…" : "Save profile"}
                </Button>
            </FrameFooter>
        </>
    );
}

function ProcessesEditor({
    processes,
    onChange,
}: {
    processes: AudioProcessConfig[];
    onChange: (processes: AudioProcessConfig[]) => void;
}) {
    const update = (index: number, patch: Partial<AudioProcessConfig>) => {
        onChange(
            processes.map((p, i) => (i === index ? { ...p, ...patch } : p))
        );
    };
    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between">
                <div>
                    <p className="font-medium">Processes</p>
                    <p className="text-xs text-muted-foreground">
                        Per-application routing rules.
                    </p>
                </div>
                <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                        onChange([
                            ...processes,
                            {
                                id: `p${processes.length + 1}`,
                                executable: "",
                                tags: [],
                                includeChildren: true,
                            },
                        ])
                    }
                >
                    <PlusIcon className="h-4 w-4" /> Add process
                </Button>
            </div>
            {processes.map((process, index) => (
                <Card
                    key={index}
                    className="flex flex-row flex-wrap items-center gap-2 bg-card/60 p-2"
                >
                    <Input
                        value={process.executable}
                        onChange={(e) =>
                            update(index, {
                                executable: e.target.value,
                                id:
                                    e.target.value
                                        .replace(/\.exe$/i, "")
                                        .toLowerCase() || process.id,
                            })
                        }
                        placeholder="Spotify.exe"
                        className="w-44 font-mono text-xs"
                    />
                    <Input
                        value={process.tags.join(",")}
                        onChange={(e) =>
                            update(index, {
                                tags: e.target.value
                                    .split(",")
                                    .map((t) => t.trim())
                                    .filter(Boolean),
                            })
                        }
                        placeholder="muted, tracked"
                        className="w-40 text-xs"
                    />
                    <label className="flex items-center gap-1.5 text-xs">
                        <Switch
                            checked={process.includeChildren}
                            onCheckedChange={(v) =>
                                update(index, { includeChildren: v })
                            }
                        />
                        include children
                    </label>
                    <Button
                        size="icon-sm"
                        variant="destructive-outline"
                        aria-label="Remove process"
                        className="ml-auto"
                        onClick={() =>
                            onChange(processes.filter((_, i) => i !== index))
                        }
                    >
                        <TrashIcon className="h-4 w-4" />
                    </Button>
                </Card>
            ))}
        </div>
    );
}

function TracksEditor({
    tracks,
    processes,
    onChange,
}: {
    tracks: AudioTrackConfig[];
    processes: AudioProcessConfig[];
    onChange: (tracks: AudioTrackConfig[]) => void;
}) {
    const available = useMemo(() => {
        const selectors = new Set<string>(BASE_SELECTORS);
        for (const p of processes) {
            if (p.id) selectors.add(`source:${p.id}`);
            for (const tag of p.tags) selectors.add(`tag:${tag}`);
        }
        selectors.add("input:mic");
        return [...selectors];
    }, [processes]);

    const update = (index: number, patch: Partial<AudioTrackConfig>) => {
        onChange(tracks.map((t, i) => (i === index ? { ...t, ...patch } : t)));
    };

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between">
                <div>
                    <p className="font-medium">Tracks</p>
                    <p className="text-xs text-muted-foreground">
                        Output audio tracks.
                    </p>
                </div>
                <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                        onChange([
                            ...tracks,
                            {
                                number:
                                    Math.max(
                                        0,
                                        ...tracks.map((t) => t.number)
                                    ) + 1,
                                name: "",
                                include: ["all_processes"],
                                exclude: [],
                            },
                        ])
                    }
                >
                    <PlusIcon className="h-4 w-4" /> Add track
                </Button>
            </div>
            {tracks.map((track, index) => (
                <Card key={index} className="space-y-2 bg-card/60 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                        <Input
                            value={track.name}
                            onChange={(e) =>
                                update(index, { name: e.target.value })
                            }
                            placeholder="Track name (e.g. discord)"
                            className="w-44 text-xs"
                        />
                        <Input
                            type="number"
                            min={1}
                            value={track.number}
                            onChange={(e) =>
                                update(index, {
                                    number: Number(e.target.value) || 1,
                                })
                            }
                            aria-label="Track number"
                            className="w-16 text-xs"
                        />
                        <Button
                            size="icon-sm"
                            variant="destructive-outline"
                            aria-label="Remove track"
                            onClick={() =>
                                onChange(tracks.filter((_, i) => i !== index))
                            }
                        >
                            <TrashIcon className="h-4 w-4" />
                        </Button>
                    </div>
                    <SelectorList
                        label="Include"
                        selectors={track.include}
                        available={available}
                        onChange={(include) => update(index, { include })}
                    />
                    <SelectorList
                        label="Exclude"
                        selectors={track.exclude}
                        available={available}
                        onChange={(exclude) => update(index, { exclude })}
                    />
                </Card>
            ))}
        </div>
    );
}

function SelectorList({
    label,
    selectors,
    available,
    onChange,
}: {
    label: string;
    selectors: string[];
    available: string[];
    onChange: (selectors: string[]) => void;
}) {
    const remaining = available.filter((s) => !selectors.includes(s));
    return (
        <div className="space-y-1">
            <p className="text-xs text-muted-foreground">{label}</p>
            <div className="flex flex-wrap items-center gap-1.5">
                {selectors.map((selector) => (
                    <Badge
                        key={selector}
                        variant="secondary"
                        className={SELECTOR_BADGE_CLASS}
                    >
                        {selector}
                        <button
                            type="button"
                            aria-label={`Remove ${selector}`}
                            className="text-muted-foreground hover:text-destructive"
                            onClick={() =>
                                onChange(
                                    selectors.filter((s) => s !== selector)
                                )
                            }
                        >
                            <XIcon className="size-3" />
                        </button>
                    </Badge>
                ))}
                {remaining.length > 0 && (
                    <Select
                        value=""
                        onValueChange={(v) => {
                            if (typeof v === "string" && v)
                                onChange([...selectors, v]);
                        }}
                    >
                        <SelectTrigger className="h-6 w-32 text-xs">
                            <SelectValue placeholder="Add…" />
                        </SelectTrigger>
                        <SelectContent>
                            {remaining.map((s) => (
                                <SelectItem key={s} value={s}>
                                    {s}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                )}
            </div>
        </div>
    );
}

function HotkeyRecorder({
    value,
    onChange,
}: {
    value: string;
    onChange: (value: string) => void;
}) {
    const [listening, setListening] = useState(false);

    useEffect(() => {
        if (!listening) return;
        const onKeyDown = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            const parts: string[] = [];
            if (e.ctrlKey) parts.push("ctrl");
            if (e.altKey) parts.push("alt");
            if (e.shiftKey) parts.push("shift");
            const code = e.code;
            if (
                code.startsWith("Key") ||
                code.startsWith("Digit") ||
                code.startsWith("Numpad")
            ) {
                parts.push(code);
            } else if (code.startsWith("F") && code.length === 2) {
                parts.push(code);
            } else if (code.startsWith("Arrow")) {
                parts.push(code.toUpperCase());
            } else if (code === "Space") {
                parts.push("Space");
            } else if (code === "ContextMenu") {
                parts.push("ContextMenu");
            } else {
                return;
            }
            onChange(parts.join("+"));
            setListening(false);
        };
        window.addEventListener("keydown", onKeyDown, true);
        return () => window.removeEventListener("keydown", onKeyDown, true);
    }, [listening, onChange]);

    return (
        <div className="flex gap-2">
            <Input
                value={value}
                readOnly
                className="font-mono text-xs"
                placeholder={
                    listening ? "Press a key combination…" : "ctrl+shift+KeyQ"
                }
            />
            <Button
                variant={listening ? "default" : "outline"}
                className="gap-2"
                onClick={() => setListening((l) => !l)}
            >
                <KeyRoundIcon className="h-4 w-4" />
                {listening ? "Listening…" : "Record"}
            </Button>
            {value && !listening && (
                <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Clear hotkey"
                    onClick={() => onChange("")}
                >
                    <XIcon className="h-4 w-4" />
                </Button>
            )}
        </div>
    );
}
