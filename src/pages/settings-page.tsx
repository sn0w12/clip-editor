import { relaunch } from "@tauri-apps/plugin-process";
import { check as checkForUpdates } from "@tauri-apps/plugin-updater";
import {
    BugIcon,
    Film as FilmIcon,
    FolderIcon,
    FolderOpenIcon,
    GridIcon,
    KeyRoundIcon,
    PlusIcon,
    SearchIcon,
    TagIcon,
    TrashIcon,
    XIcon,
    Zap as BoltIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
    Frame,
    FrameDescription,
    FrameFooter,
    FrameHeader,
    FramePanel,
    FrameTitle,
} from "@/components/ui/frame";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
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
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { toastManager } from "@/components/ui/toast";
import { useConfirm } from "@/contexts/confirm-context";
import {
    useSetting,
    useSettings,
    setSetting as persistSetting,
    resetAllSettingsToDefault,
} from "@/lib/settings";
import { selectDirectory, selectFile, getLibraryRoots } from "@/lib/tauri";
import { displayPath } from "@/lib/utils";
import { useRecordingStore } from "@/stores/recording-store";
import type { AudioProcessConfig, AudioTrackConfig, RecordingProfile } from "@/types";

import pkg from "../../package.json";

type ShortcutDef = [key: string, label: string, defaultValue: string];

const SHORTCUT_GROUPS: { title: string; shortcuts: ShortcutDef[] }[] = [
    {
        title: "Navigation",
        shortcuts: [
            ["toggleSidebar", "Toggle sidebar", "Ctrl+B"],
            ["goToNextVideo", "Next video", "Ctrl+Shift+ARROWRIGHT"],
            ["goToPreviousVideo", "Previous video", "Ctrl+Shift+ARROWLEFT"],
        ],
    },
    {
        title: "Selection",
        shortcuts: [
            ["selectAll", "Select all", "Ctrl+A"],
            ["selectNone", "Select none", "Ctrl+D"],
            ["selectInvert", "Invert selection", "Ctrl+I"],
            ["continueSelection", "Continue selection", "Shift"],
        ],
    },
    {
        title: "Playback",
        shortcuts: [
            ["pauseVideo", "Pause / play", "Space"],
            ["toggleFullscreen", "Fullscreen", "F"],
            ["muteSound", "Mute", "M"],
            ["volumeUp", "Volume up", "ARROWUP"],
            ["volumeDown", "Volume down", "ARROWDOWN"],
            ["skipForward", "Skip forward", "ARROWRIGHT"],
            ["skipBackward", "Skip backward", "ARROWLEFT"],
        ],
    },
    {
        title: "Markers & cuts",
        shortcuts: [
            ["skipToStart", "Skip to start", "Ctrl+ARROWLEFT"],
            ["skipToEnd", "Skip to end", "Ctrl+ARROWRIGHT"],
            ["skipToStartMarker", "Skip to start marker", "Shift+ARROWLEFT"],
            ["skipToEndMarker", "Skip to end marker", "Shift+ARROWRIGHT"],
            ["setStartMarker", "Set start marker", "Ctrl+J"],
            ["setEndMarker", "Set end marker", "Ctrl+L"],
            ["addCut", "Add cut", "Ctrl+K"],
            ["setEndCut", "Set end cut", "Ctrl+Shift+K"],
        ],
    },
    {
        title: "Export",
        shortcuts: [["exportClip", "Export clip", "Ctrl+E"]],
    },
];

const EXPORT_FORMATS = ["mp4", "webm", "mov", "mkv", "gif"].map((f) => ({
    label: f,
    value: f,
}));
const EXPORT_QUALITIES = ["high", "medium", "low"].map((q) => ({
    label: q,
    value: q,
}));
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

export function SettingsPage() {
    const confirm = useConfirm();
    const [tab, setTab] = useState("general");
    return (
        <div className="mx-auto flex h-full max-w-4xl flex-col gap-4 p-6">
            <div className="flex items-center justify-between">
                <h1 className="text-3xl font-bold">Settings</h1>
                <Button
                    variant="destructive-outline"
                    onClick={async () => {
                        const ok = await confirm({
                            title: "Reset all settings?",
                            description:
                                "Restores defaults. Your clips, groups, and games are untouched.",
                            confirmText: "Reset",
                            variant: "destructive",
                        });
                        if (ok) {
                            await toastManager
                                .promise(resetAllSettingsToDefault(), {
                                    loading: { title: "Resetting settings…" },
                                    success: { title: "Settings reset" },
                                    error: (e) => ({
                                        title: `Failed to reset settings: ${String(e)}`,
                                    }),
                                })
                                .catch(() => {});
                        }
                    }}
                >
                    Reset settings
                </Button>
            </div>
            <Tabs value={tab} onValueChange={setTab} className="pb-6">
                <TabsList>
                    <TabsTab value="general">General</TabsTab>
                    <TabsTab value="editor">Editor</TabsTab>
                    <TabsTab value="recording">Recording</TabsTab>
                    <TabsTab value="shortcuts">Shortcuts</TabsTab>
                    <TabsTab value="search">Search</TabsTab>
                    <TabsTab value="about">About</TabsTab>
                </TabsList>
                <TabsPanel value="general">
                    <GeneralSettings />
                </TabsPanel>
                <TabsPanel value="editor">
                    <EditorSettings />
                </TabsPanel>
                <TabsPanel value="recording">
                    <RecordingSettings />
                </TabsPanel>
                <TabsPanel value="shortcuts">
                    <ShortcutSettings />
                </TabsPanel>
                <TabsPanel value="search">
                    <SearchSettings onNavigate={setTab} />
                </TabsPanel>
                <TabsPanel value="about">
                    <AboutSettings />
                </TabsPanel>
            </Tabs>
        </div>
    );
}

/** A titled, padded section inside a settings `Frame`. */
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
                {description && <FrameDescription>{description}</FrameDescription>}
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
                {description && <p className="text-muted-foreground text-xs">{description}</p>}
            </div>
            <div className="mt-1">{children}</div>
        </div>
    );
}

function GeneralSettings() {
    const steamDirectory = useSetting<string>("steamDirectory");
    const launchOnStartup = useSetting<boolean>("launchOnStartup");

    const browse = async () => {
        const dir = await selectDirectory();
        if (dir) {
            await persistSetting("steamDirectory", dir);
            toastManager.add({ title: "Steam directory updated", type: "success" });
        }
    };

    return (
        <Frame>
            <SettingsPanel title="General">
                <SettingEntry
                    label="Launch on Windows startup"
                    description="Start Clip Editor (and the replay buffer) when you sign in."
                >
                    <Switch
                        checked={launchOnStartup ?? true}
                        onCheckedChange={(v) => void persistSetting("launchOnStartup", v)}
                    />
                </SettingEntry>
            </SettingsPanel>
            <SettingsPanel
                title="Steam"
                description="Games and artwork are scanned from this Steam install root."
            >
                <div className="flex gap-2">
                    <Input
                        value={displayPath(steamDirectory ?? "")}
                        readOnly
                        className="font-mono text-xs"
                    />
                    <Button variant="outline" onClick={() => void browse()}>
                        <FolderOpenIcon /> Browse
                    </Button>
                </div>
            </SettingsPanel>
        </Frame>
    );
}

function EditorSettings() {
    const defaultExportFormat = useSetting<string>("defaultExportFormat");
    const defaultExportQuality = useSetting<string>("defaultExportQuality");
    const defaultAudioTrack = useSetting<string>("defaultAudioTrack");
    const chooseExportLocation = useSetting<boolean>("chooseExportLocation");
    const alwaysCopyExport = useSetting<boolean>("alwaysCopyExport");
    const seekIncrement = useSetting<number>("seekIncrement");
    const holdSpeed = useSetting<number>("holdSpeed");

    return (
        <Frame>
            <SettingsPanel
                title="Export defaults"
                description="Defaults for the clip editor's export panel."
            >
                <SettingGrid>
                    <SettingEntry label="Default export format">
                        <Select
                            value={defaultExportFormat ?? "mp4"}
                            items={EXPORT_FORMATS}
                            onValueChange={(v) => {
                                if (v !== null) void persistSetting("defaultExportFormat", v);
                            }}
                        >
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {EXPORT_FORMATS.map((f) => (
                                    <SelectItem key={f.value} value={f.value}>
                                        {f.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </SettingEntry>
                    <SettingEntry label="Default export quality">
                        <Select
                            value={defaultExportQuality ?? "medium"}
                            items={EXPORT_QUALITIES}
                            onValueChange={(v) => {
                                if (v !== null) void persistSetting("defaultExportQuality", v);
                            }}
                        >
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {EXPORT_QUALITIES.map((q) => (
                                    <SelectItem key={q.value} value={q.value}>
                                        {q.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </SettingEntry>
                    <SettingEntry label="Default audio track">
                        <Input
                            type="number"
                            min={0}
                            value={defaultAudioTrack ?? "0"}
                            onChange={(e) =>
                                void persistSetting("defaultAudioTrack", e.target.value)
                            }
                        />
                    </SettingEntry>
                    <SettingEntry label="Ask where to save exports">
                        <Switch
                            checked={chooseExportLocation ?? false}
                            onCheckedChange={(v) => void persistSetting("chooseExportLocation", v)}
                        />
                    </SettingEntry>
                    <SettingEntry label="Always copy exports to clipboard">
                        <Switch
                            checked={alwaysCopyExport ?? false}
                            onCheckedChange={(v) => void persistSetting("alwaysCopyExport", v)}
                        />
                    </SettingEntry>
                    <SettingEntry label={`Seek increment: ${seekIncrement ?? 5}s`}>
                        <Slider
                            value={[seekIncrement ?? 5]}
                            min={1}
                            max={60}
                            onValueChange={(v) =>
                                void persistSetting(
                                    "seekIncrement",
                                    (Array.isArray(v) ? v : [v])[0],
                                )
                            }
                        />
                    </SettingEntry>
                    <SettingEntry label={`Hold-to-speed: ${holdSpeed ?? 2}×`}>
                        <Slider
                            value={[holdSpeed ?? 2]}
                            min={1}
                            max={10}
                            onValueChange={(v) =>
                                void persistSetting("holdSpeed", (Array.isArray(v) ? v : [v])[0])
                            }
                        />
                    </SettingEntry>
                </SettingGrid>
            </SettingsPanel>
        </Frame>
    );
}

function RecordingSettings() {
    const {
        error: recordingError,
        running,
        availableSeconds,
        targetSeconds,
        saving: isBufferSaving,
        save: saveBuffer,
        stop,
        start,
        getProfileSync,
        setProfile: saveProfile,
    } = useRecordingStore();
    const [profile, setProfile] = useState<RecordingProfile>(getProfileSync());
    const [saving, setSaving] = useState(false);
    const startReplayBufferOnStartup = useSetting<boolean>("startReplayBufferOnStartup");
    // The library root (viewed directory) is the save location; read it live
    // so the display tracks the directory browsed to on the home page.
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

    // Auto-persist edits (debounced) so changes — especially audio routing —
    // survive tab switches and navigation without needing the explicit save
    // button. Intermediate invalid states are skipped silently; the Save
    // button still surfaces real validation errors.
    const isFirstRender = useRef(true);
    useEffect(() => {
        if (isFirstRender.current) {
            isFirstRender.current = false;
            return;
        }
        if (!profile) return;
        const timer = window.setTimeout(() => {
            void saveProfile(profile).catch(() => {});
        }, 800);
        return () => window.clearTimeout(timer);
    }, [profile, saveProfile]);

    const update = (patch: Partial<RecordingProfile>) => setProfile((p) => ({ ...p, ...patch }));

    const save = async () => {
        if (!profile) return;
        setSaving(true);
        try {
            await toastManager
                .promise(saveProfile(profile), {
                    loading: { title: "Saving recording profile…" },
                    success: { title: "Recording profile saved" },
                    error: (e) => ({ title: `Failed to save profile: ${String(e)}` }),
                })
                .catch(() => {});
        } finally {
            setSaving(false);
        }
    };

    const browseSound = async () => {
        const file = await selectFile();
        if (file) update({ successSound: file });
    };

    return (
        <Frame>
            {recordingError && <Alert variant="warning">{recordingError}</Alert>}
            <FramePanel className="p-0">
                <div className="flex flex-row items-center justify-between px-5 py-4">
                    <FrameTitle>Buffer</FrameTitle>
                    <div className="flex items-center gap-2 text-sm">
                        <span className={running ? "text-destructive" : "text-muted-foreground"}>
                            {running ? "● Buffer running" : "Buffer stopped"}
                        </span>
                        {running && (
                            <span className="text-muted-foreground">
                                {availableSeconds.toFixed(1)}s / {targetSeconds}s
                                {isBufferSaving ? " · saving…" : ""}
                            </span>
                        )}
                        {running ? (
                            <>
                                <Button
                                    size="sm"
                                    variant="success"
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
                                variant="success"
                                onClick={() => {
                                    void toastManager
                                        .promise(start(), {
                                            loading: { title: "Starting replay buffer…" },
                                            success: { title: "Replay buffer started" },
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
                                void persistSetting("startReplayBufferOnStartup", v)
                            }
                        />
                    </SettingEntry>
                    <SettingEntry label={`Buffer duration: ${profile.durationSeconds}s`}>
                        <Slider
                            value={[profile.durationSeconds]}
                            min={3}
                            max={300}
                            step={1}
                            onValueChange={(v) =>
                                update({
                                    durationSeconds: (Array.isArray(v) ? v : [v])[0],
                                })
                            }
                        />
                    </SettingEntry>
                    <SettingEntry label={`Segment length: ${profile.segmentSeconds}s`}>
                        <Slider
                            value={[profile.segmentSeconds]}
                            min={1}
                            max={10}
                            step={1}
                            onValueChange={(v) =>
                                update({
                                    segmentSeconds: (Array.isArray(v) ? v : [v])[0],
                                })
                            }
                        />
                    </SettingEntry>
                </div>
            </FramePanel>

            <SettingsPanel title="Capture" description="How the replay buffer records your screen.">
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
                                if (v !== null) update({ monitor: v });
                            }}
                        >
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="primary">Primary monitor</SelectItem>
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
                                if (v !== null) update({ codec: v });
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
                                if (v !== null) update({ sampleRate: Number(v) });
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
                                if (v !== null) update({ channels: Number(v) });
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
                        onChange={(processes) => update({ processes, audioRouting: "all" })}
                    />
                    <Separator />
                    <TracksEditor
                        tracks={profile.tracks}
                        processes={profile.processes}
                        onChange={(tracks) => update({ tracks, audioRouting: "all" })}
                    />
                </div>
            </SettingsPanel>

            <SettingsPanel title="Save" description="How clips are saved from the replay buffer.">
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
                        description="Clips save into the directory you browse to in the library — no separate output directory."
                    >
                        <Input
                            value={displayPath(saveDir ?? profile.outputDir)}
                            readOnly
                            className="font-mono text-xs"
                        />
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
                            <Button variant="outline" onClick={() => void browseSound()}>
                                <FolderOpenIcon /> Browse
                            </Button>
                            {profile.successSound && (
                                <Button
                                    variant="ghost"
                                    aria-label="Clear sound"
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
        </Frame>
    );
}

const BASE_SELECTORS = ["all_processes", "all_nonmuted_processes"];

function ProcessesEditor({
    processes,
    onChange,
}: {
    processes: AudioProcessConfig[];
    onChange: (processes: AudioProcessConfig[]) => void;
}) {
    const update = (index: number, patch: Partial<AudioProcessConfig>) => {
        onChange(processes.map((p, i) => (i === index ? { ...p, ...patch } : p)));
    };
    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between">
                <div>
                    <p className="font-medium">Processes</p>
                    <p className="text-muted-foreground text-xs">Per-application routing rules.</p>
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
            {processes.length === 0 && <p className="text-muted-foreground text-sm"></p>}
            {processes.map((process, index) => (
                <Card
                    key={index}
                    className="bg-card/60 flex flex-row flex-wrap items-center gap-2 p-2"
                >
                    <Input
                        value={process.executable}
                        onChange={(e) =>
                            update(index, {
                                executable: e.target.value,
                                id:
                                    e.target.value.replace(/\.exe$/i, "").toLowerCase() ||
                                    process.id,
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
                            onCheckedChange={(v) => update(index, { includeChildren: v })}
                        />
                        include children
                    </label>
                    <Button
                        size="icon-sm"
                        variant="destructive-outline"
                        aria-label="Remove process"
                        className="ml-auto"
                        onClick={() => onChange(processes.filter((_, i) => i !== index))}
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
        const selectors = [...BASE_SELECTORS];
        for (const p of processes) {
            if (p.id) selectors.push(`source:${p.id}`);
            for (const tag of p.tags) selectors.push(`tag:${tag}`);
        }
        selectors.push("input:mic");
        return selectors;
    }, [processes]);

    const update = (index: number, patch: Partial<AudioTrackConfig>) => {
        onChange(tracks.map((t, i) => (i === index ? { ...t, ...patch } : t)));
    };

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between">
                <div>
                    <p className="font-medium">Tracks</p>
                    <p className="text-muted-foreground text-xs">Output audio tracks.</p>
                </div>
                <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                        onChange([
                            ...tracks,
                            {
                                number: Math.max(0, ...tracks.map((t) => t.number)) + 1,
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
                <Card key={index} className="bg-card/60 space-y-2 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                        <Input
                            value={track.name}
                            onChange={(e) => update(index, { name: e.target.value })}
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
                            onClick={() => onChange(tracks.filter((_, i) => i !== index))}
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
            <p className="text-muted-foreground text-xs">{label}</p>
            <div className="flex flex-wrap items-center gap-1.5">
                {selectors.map((selector) => (
                    <Badge
                        key={selector}
                        variant="secondary"
                        size="xl"
                        className="gap-1 pr-2 font-mono text-xs"
                    >
                        {selector}
                        <button
                            type="button"
                            aria-label={`Remove ${selector}`}
                            className="text-muted-foreground hover:text-destructive"
                            onClick={() => onChange(selectors.filter((s) => s !== selector))}
                        >
                            <XIcon className="size-3" />
                        </button>
                    </Badge>
                ))}
                {remaining.length > 0 && (
                    <Select value="" onValueChange={(v) => v && onChange([...selectors, v])}>
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

function HotkeyRecorder({ value, onChange }: { value: string; onChange: (value: string) => void }) {
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
            if (code.startsWith("Key") || code.startsWith("Digit") || code.startsWith("Numpad")) {
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
                placeholder={listening ? "Press a key combination…" : "ctrl+shift+KeyQ"}
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

function ShortcutSettings() {
    return (
        <Frame>
            {SHORTCUT_GROUPS.map((group) => (
                <SettingsPanel key={group.title} title={group.title}>
                    <div className="space-y-4">
                        {group.shortcuts.map(([key, label, hint]) => (
                            <ShortcutRow key={key} settingKey={key} label={label} hint={hint} />
                        ))}
                    </div>
                </SettingsPanel>
            ))}
        </Frame>
    );
}

/** Build the app shortcut string (`Ctrl+Shift+ARROWRIGHT`, `Space`, `F`, ...)
 * from a keydown. Returns null for modifier-only or unsupported presses. */
function formatShortcut(e: KeyboardEvent): string | null {
    if (e.key === "Escape") return null;
    if (e.key === "Control" || e.key === "Shift" || e.key === "Alt" || e.key === "Meta") {
        return null;
    }
    const mods: string[] = [];
    if (e.ctrlKey) mods.push("Ctrl");
    if (e.shiftKey) mods.push("Shift");
    if (e.altKey) mods.push("Alt");
    if (e.metaKey) mods.push("Meta");
    const key = e.key === " " ? "Space" : e.key.toUpperCase();
    return [...mods, key].join("+");
}

function ShortcutRecorder({
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
            if (e.key === "Escape") {
                setListening(false);
                return;
            }
            const shortcut = formatShortcut(e);
            if (shortcut === null) return;
            onChange(shortcut);
            setListening(false);
        };
        window.addEventListener("keydown", onKeyDown, true);
        return () => window.removeEventListener("keydown", onKeyDown, true);
    }, [listening, onChange]);

    return (
        <div className="flex items-center gap-2">
            <kbd className="bg-muted text-muted-foreground inline-flex h-7 min-w-16 items-center justify-center rounded-md border px-2 font-mono text-xs">
                {listening ? "Press keys…" : value || "None"}
            </kbd>
            <Button
                size="sm"
                variant={listening ? "default" : "outline"}
                className="gap-2"
                onClick={() => setListening((l) => !l)}
            >
                <KeyRoundIcon className="h-4 w-4" />
                {listening ? "Listening…" : "Record"}
            </Button>
            {value && !listening && (
                <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Clear shortcut"
                    onClick={() => onChange("")}
                >
                    Clear
                </Button>
            )}
        </div>
    );
}

function ShortcutRow({
    settingKey,
    label,
    hint,
}: {
    settingKey: string;
    label: string;
    hint: string;
}) {
    const value = useSetting<string>(`shortcut_${settingKey}`);
    const setShortcut = (next: string) => void persistSetting(`shortcut_${settingKey}`, next);
    return (
        <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
                <Label className="font-medium">{label}</Label>
                <p className="text-muted-foreground text-xs">Default: {hint}</p>
            </div>
            <ShortcutRecorder value={value ?? ""} onChange={setShortcut} />
        </div>
    );
}

interface SearchEntry {
    key: string;
    label: string;
    description?: string;
    tab: string;
    value: string;
}

const TAB_LABELS: Record<string, string> = {
    general: "General",
    editor: "Editor",
    recording: "Recording",
    shortcuts: "Shortcuts",
};

function SearchSettings({ onNavigate }: { onNavigate: (tab: string) => void }) {
    const [query, setQuery] = useState("");
    const settings = useSettings();
    const profile = useRecordingStore().getProfileSync();

    const fmt = (v: unknown): string => {
        if (typeof v === "boolean") return v ? "On" : "Off";
        if (v === undefined || v === null || v === "") return "—";
        return String(v);
    };
    const val = (key: string, fallback: unknown = "") => {
        const v = settings[key];
        return v === undefined || v === null || v === "" ? fmt(fallback) : fmt(v);
    };

    const settingDefs: (Omit<SearchEntry, "value"> & { fallback?: unknown })[] = [
        { key: "theme", label: "Theme", tab: "general" },
        {
            key: "steamDirectory",
            label: "Steam directory",
            description: "Steam install root used for game artwork.",
            tab: "general",
        },
        {
            key: "launchOnStartup",
            label: "Launch on Windows startup",
            tab: "general",
            fallback: true,
        },
        {
            key: "startReplayBufferOnStartup",
            label: "Start replay buffer on startup",
            tab: "recording",
            fallback: true,
        },
        {
            key: "defaultExportFormat",
            label: "Default export format",
            tab: "editor",
            fallback: "mp4",
        },
        {
            key: "defaultExportQuality",
            label: "Default export quality",
            tab: "editor",
            fallback: "medium",
        },
        { key: "defaultAudioTrack", label: "Default audio track", tab: "editor", fallback: "0" },
        {
            key: "chooseExportLocation",
            label: "Ask where to save exports",
            tab: "editor",
            fallback: false,
        },
        {
            key: "alwaysCopyExport",
            label: "Always copy exports to clipboard",
            tab: "editor",
            fallback: false,
        },
        { key: "seekIncrement", label: "Seek increment", tab: "editor", fallback: 5 },
        { key: "holdSpeed", label: "Hold-to-speed", tab: "editor", fallback: 2 },
    ];
    const shortcutDefs: (Omit<SearchEntry, "value"> & { fallback?: string })[] =
        SHORTCUT_GROUPS.flatMap((group) =>
            group.shortcuts.map(([key, label, def]) => ({
                key: `shortcut_${key}`,
                label: `Shortcut · ${label}`,
                description: `Default: ${def}`,
                tab: "shortcuts" as const,
                fallback: def,
            })),
        );
    const profileDefs: (Omit<SearchEntry, "value"> & { value: unknown })[] = [
        {
            key: "bufferDuration",
            label: "Buffer duration",
            tab: "recording",
            value: profile.durationSeconds,
        },
        {
            key: "segmentSeconds",
            label: "Segment length",
            tab: "recording",
            value: profile.segmentSeconds,
        },
        { key: "fps", label: "Capture FPS", tab: "recording", value: profile.fps },
        { key: "codec", label: "Video codec", tab: "recording", value: profile.codec },
        { key: "quality", label: "Capture quality", tab: "recording", value: profile.quality },
        { key: "cursor", label: "Capture cursor", tab: "recording", value: profile.cursor },
        { key: "sampleRate", label: "Sample rate", tab: "recording", value: profile.sampleRate },
        { key: "channels", label: "Audio channels", tab: "recording", value: profile.channels },
        { key: "hotkey", label: "Global save hotkey", tab: "recording", value: profile.hotkey },
        {
            key: "successSound",
            label: "Sound on save",
            tab: "recording",
            value: profile.successSound,
        },
    ];
    const entries: SearchEntry[] = [
        ...settingDefs.map(({ fallback, ...d }) => ({ ...d, value: val(d.key, fallback) })),
        ...shortcutDefs.map(({ fallback, ...d }) => ({ ...d, value: val(d.key, fallback) })),
        ...profileDefs.map(({ value, ...d }) => ({ ...d, value: fmt(value) })),
    ];

    const q = query.trim().toLowerCase();
    const results = q
        ? entries.filter(
              (e) =>
                  e.label.toLowerCase().includes(q) ||
                  e.key.toLowerCase().includes(q) ||
                  (e.description ?? "").toLowerCase().includes(q) ||
                  e.value.toLowerCase().includes(q),
          )
        : [];

    return (
        <Frame>
            <SettingsPanel
                title="Search settings"
                description="Find any setting by name, key, or current value."
            >
                <InputGroup>
                    <InputGroupAddon>
                        <SearchIcon className="text-muted-foreground" />
                    </InputGroupAddon>
                    <InputGroupInput
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search settings…"
                        autoFocus
                    />
                </InputGroup>

                {query.trim() === "" ? (
                    <p className="text-muted-foreground mt-4 text-sm">
                        Start typing to search across every setting, shortcut, and recording option.
                    </p>
                ) : results.length === 0 ? (
                    <p className="text-muted-foreground mt-4 text-sm">
                        No settings found matching your search.
                    </p>
                ) : (
                    <div className="mt-4 space-y-1.5">
                        {results.map((result) => (
                            <div
                                key={result.key}
                                className="hover:bg-accent/50 flex items-center justify-between gap-3 rounded-md border p-2.5"
                            >
                                <div className="min-w-0">
                                    <p className="truncate text-sm font-medium">{result.label}</p>
                                    <p className="text-muted-foreground truncate text-xs">
                                        <span className="font-mono">{result.value}</span>
                                        {result.description && <span> · {result.description}</span>}
                                    </p>
                                </div>
                                <div className="flex shrink-0 items-center gap-2">
                                    <Badge variant="outline">
                                        {TAB_LABELS[result.tab] ?? result.tab}
                                    </Badge>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => onNavigate(result.tab)}
                                    >
                                        Go
                                    </Button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </SettingsPanel>
        </Frame>
    );
}

function AboutSettings() {
    const [updateStatus, setUpdateStatus] = useState<
        "idle" | "checking" | "installing" | "up-to-date" | "error"
    >("idle");
    const [updateError, setUpdateError] = useState("");

    const handleCheckForUpdates = async () => {
        setUpdateStatus("checking");
        setUpdateError("");
        try {
            const update = await checkForUpdates();
            if (!update) {
                setUpdateStatus("up-to-date");
                return;
            }
            setUpdateStatus("installing");
            await update.downloadAndInstall();
            await relaunch();
        } catch (e) {
            setUpdateStatus("error");
            setUpdateError(String(e));
        }
    };

    return (
        <Frame>
            <SettingsPanel
                title="Clip Editor"
                description="A desktop application for editing, managing, and organizing your video clips. Built with Tauri, React, and Rust."
            >
                <p className="text-muted-foreground mb-4 text-sm">Version {pkg.version}</p>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <FeatureCard
                        icon={<FilmIcon />}
                        title="Edit Video Clips"
                        body="Trim video clips by setting custom start and end points"
                    />
                    <FeatureCard
                        icon={<FolderIcon />}
                        title="Organize Content"
                        body="Group related clips together with customizable colored tags"
                    />
                    <FeatureCard
                        icon={<BoltIcon />}
                        title="Game Detection"
                        body="Automatically categorize clips by game with Steam integration"
                    />
                    <FeatureCard
                        icon={<GridIcon />}
                        title="Advanced Filtering"
                        body="Find clips by date, game, or custom groups"
                    />
                </div>
            </SettingsPanel>

            <SettingsPanel title="Links">
                <div className="flex flex-wrap gap-2">
                    <a
                        href="https://github.com/sn0w12/clip-editor"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        <Button variant="outline" size="sm" className="gap-2">
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                width="16"
                                height="16"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                aria-hidden="true"
                            >
                                <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
                                <path d="M9 18c-4.51 2-5-2-7-2" />
                            </svg>
                            Repository
                        </Button>
                    </a>
                    <a
                        href="https://github.com/sn0w12/clip-editor/issues"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        <Button variant="outline" size="sm" className="gap-2">
                            <BugIcon className="h-4 w-4" />
                            Issues
                        </Button>
                    </a>
                    <a
                        href="https://github.com/sn0w12/clip-editor/releases"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        <Button variant="outline" size="sm" className="gap-2">
                            <TagIcon className="h-4 w-4" />
                            Releases
                        </Button>
                    </a>
                </div>
            </SettingsPanel>

            <SettingsPanel title="Updates">
                <div className="flex items-center gap-3">
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleCheckForUpdates()}
                        disabled={updateStatus === "checking" || updateStatus === "installing"}
                    >
                        {updateStatus === "checking"
                            ? "Checking…"
                            : updateStatus === "installing"
                              ? "Installing…"
                              : "Check for updates"}
                    </Button>
                    {updateStatus === "up-to-date" && (
                        <p className="text-muted-foreground text-sm">You're up to date.</p>
                    )}
                    {updateStatus === "error" && (
                        <p className="text-muted-foreground text-sm">
                            Update check failed: {updateError}
                        </p>
                    )}
                </div>
            </SettingsPanel>

            <FrameFooter className="flex items-center justify-center">
                <p className="text-muted-foreground text-xs">
                    © {new Date().getFullYear()} Clip Editor. Licensed under the GPL-3.0-only
                    License.
                </p>
            </FrameFooter>
        </Frame>
    );
}

function FeatureCard({
    icon,
    title,
    body,
}: {
    icon: React.ReactNode;
    title: string;
    body: string;
}) {
    return (
        <Card className="bg-card/60 flex items-start gap-2 p-3">
            <div className="bg-primary/10 mt-0.5 rounded-full p-1">{icon}</div>
            <div>
                <h5 className="font-medium">{title}</h5>
                <p className="text-muted-foreground text-sm">{body}</p>
            </div>
        </Card>
    );
}
