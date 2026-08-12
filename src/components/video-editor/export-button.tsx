import { ChevronDown, Save, Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogClose,
    DialogFooter,
    DialogHeader,
    DialogPanel,
    DialogPopup,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/contexts/confirm-context";
import { useShortcutSetting } from "@/lib/settings";
import type { ExportOptions } from "@/types";

interface ExportButtonProps {
    onExport: (options: Partial<ExportOptions>) => void;
    isExporting: boolean;
    baseOptions: Partial<ExportOptions>;
}

export interface ExportPreset {
    name: string;
    description: string;
    options: Partial<ExportOptions>;
    isCustom?: boolean;
}

const DEFAULT_PRESETS: ExportPreset[] = [
    {
        name: "Discord",
        description: "Optimized for Discord (<10MB)",
        options: {
            qualityMode: "targetSize",
            targetSize: 8.5,
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

const LOCAL_STORAGE_KEY = "clipEditor_customExportPresets";

export function ExportButton({ onExport, isExporting, baseOptions }: ExportButtonProps) {
    const [presets, setPresets] = useState<ExportPreset[]>(() => {
        try {
            const savedPresetsJson = localStorage.getItem(LOCAL_STORAGE_KEY);
            if (savedPresetsJson) {
                const customPresets = JSON.parse(savedPresetsJson) as ExportPreset[];
                return [...DEFAULT_PRESETS, ...customPresets];
            }
        } catch (error) {
            console.error("Failed to load custom presets:", error);
        }
        return DEFAULT_PRESETS;
    });
    const [saveDialogOpen, setSaveDialogOpen] = useState(false);
    const [newPresetName, setNewPresetName] = useState("");
    const [newPresetDescription, setNewPresetDescription] = useState("");
    const confirm = useConfirm();

    const handleDirectExport = () => {
        onExport(baseOptions);
    };
    useShortcutSetting("exportClip", handleDirectExport);

    const saveCustomPresets = (customPresets: ExportPreset[]) => {
        try {
            localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(customPresets));
            setPresets([...DEFAULT_PRESETS, ...customPresets]);
        } catch (error) {
            console.error("Failed to save custom presets:", error);
        }
    };

    const handleSavePreset = () => {
        if (!newPresetName.trim()) return;

        const newPreset: ExportPreset = {
            name: newPresetName.trim(),
            description: newPresetDescription.trim() || "Custom preset",
            options: { ...baseOptions },
            isCustom: true,
        };

        const customPresets = presets.filter((preset) => preset.isCustom) || [];
        saveCustomPresets([...customPresets, newPreset]);
        setSaveDialogOpen(false);
        setNewPresetName("");
        setNewPresetDescription("");
    };

    const handleDeletePreset = async (presetToDelete: ExportPreset) => {
        const confirmed = await confirm({
            title: "Delete Preset",
            description: `Are you sure you want to delete the preset "${presetToDelete.name}"?`,
            confirmText: "Delete",
            variant: "destructive",
        });
        if (confirmed) {
            const customPresets = presets.filter(
                (preset) => preset.isCustom && preset.name !== presetToDelete.name,
            );
            saveCustomPresets(customPresets);
        }
    };

    const handlePresetExport = (preset: ExportPreset) => {
        onExport({
            ...baseOptions,
            ...preset.options,
        });
    };

    const customPresets = presets.filter((preset) => preset.isCustom);
    const defaultPresets = presets.filter((preset) => !preset.isCustom);

    return (
        <div className="flex w-full">
            <Button
                className="flex-1 justify-center rounded-r-none text-center"
                onClick={handleDirectExport}
                disabled={isExporting}
            >
                {isExporting ? "Exporting..." : "Export Clip"}
            </Button>

            <DropdownMenu>
                <DropdownMenuTrigger
                    render={
                        <Button
                            size="icon"
                            className="rounded-l-none border-l"
                            disabled={isExporting}
                            aria-label="Export presets"
                        >
                            <ChevronDown className="h-4 w-4" />
                        </Button>
                    }
                />
                <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuItem
                        onClick={() => setSaveDialogOpen(true)}
                        className="cursor-pointer"
                    >
                        <Save className="mr-2 h-4 w-4" />
                        Save Settings as Preset
                    </DropdownMenuItem>

                    <DropdownMenuSeparator />

                    <DropdownMenuGroup>
                        <DropdownMenuLabel>Default Presets</DropdownMenuLabel>
                        {defaultPresets.map((preset, index) => (
                            <DropdownMenuItem
                                key={`default-${index}`}
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
                    </DropdownMenuGroup>

                    {customPresets.length > 0 && (
                        <>
                            <DropdownMenuSeparator />
                            <DropdownMenuGroup>
                                <DropdownMenuLabel>Custom Presets</DropdownMenuLabel>
                                {customPresets.map((preset, index) => (
                                    <DropdownMenuItem
                                        key={`custom-${index}`}
                                        className="flex justify-between"
                                        onClick={() => handlePresetExport(preset)}
                                    >
                                        <div className="flex min-w-0 flex-1 flex-col">
                                            <span>{preset.name}</span>
                                            <span className="text-muted-foreground text-xs">
                                                {preset.description}
                                            </span>
                                        </div>
                                        <span
                                            role="button"
                                            tabIndex={0}
                                            className="hover:bg-destructive/10 text-destructive -m-1 flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded"
                                            aria-label={`Delete preset ${preset.name}`}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                void handleDeletePreset(preset);
                                            }}
                                            onKeyDown={(e) => {
                                                if (e.key === "Enter" || e.key === " ") {
                                                    e.stopPropagation();
                                                    void handleDeletePreset(preset);
                                                }
                                            }}
                                        >
                                            <Trash2 className="h-4 w-4" />
                                        </span>
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuGroup>
                        </>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>

            <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
                <DialogPopup className="sm:max-w-sm">
                    <DialogHeader>
                        <DialogTitle>Save Export Preset</DialogTitle>
                    </DialogHeader>
                    <DialogPanel className="grid gap-4">
                        <Field>
                            <FieldLabel>Preset Name</FieldLabel>
                            <Input
                                id="preset-name"
                                value={newPresetName}
                                onChange={(e) => setNewPresetName(e.target.value)}
                                placeholder="My Custom Preset"
                            />
                        </Field>
                        <Field>
                            <FieldLabel>Description (optional)</FieldLabel>
                            <Input
                                id="preset-description"
                                value={newPresetDescription}
                                onChange={(e) => setNewPresetDescription(e.target.value)}
                                placeholder="Custom settings for specific use case"
                            />
                        </Field>
                    </DialogPanel>
                    <DialogFooter>
                        <DialogClose render={<Button variant="ghost">Cancel</Button>} />
                        <Button onClick={handleSavePreset}>Save Preset</Button>
                    </DialogFooter>
                </DialogPopup>
            </Dialog>
        </div>
    );
}
