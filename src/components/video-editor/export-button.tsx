import React, { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    DropdownMenuSeparator,
    DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { ChevronDown, Save, Trash2 } from "lucide-react";
import { ExportOptions } from "@/types/video-editor";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useConfirm } from "@/contexts/confirm-context";
import { useShortcutSetting } from "@/utils/settings";

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

export function ExportButton({
    onExport,
    isExporting,
    baseOptions,
}: ExportButtonProps) {
    const [presets, setPresets] = useState<ExportPreset[]>(DEFAULT_PRESETS);
    const [saveDialogOpen, setSaveDialogOpen] = useState(false);
    const [newPresetName, setNewPresetName] = useState("");
    const [newPresetDescription, setNewPresetDescription] = useState("");
    const { confirm } = useConfirm();

    useEffect(() => {
        loadCustomPresets();
    }, []);

    const handleDirectExport = () => {
        onExport(baseOptions);
    };
    useShortcutSetting("exportClip", handleDirectExport);

    const loadCustomPresets = () => {
        try {
            const savedPresetsJson = localStorage.getItem(LOCAL_STORAGE_KEY);
            if (savedPresetsJson) {
                const customPresets = JSON.parse(
                    savedPresetsJson,
                ) as ExportPreset[];
                setPresets([...DEFAULT_PRESETS, ...customPresets]);
            }
        } catch (error) {
            console.error("Failed to load custom presets:", error);
        }
    };

    const saveCustomPresets = (customPresets: ExportPreset[]) => {
        try {
            localStorage.setItem(
                LOCAL_STORAGE_KEY,
                JSON.stringify(customPresets),
            );
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

        // Get existing custom presets
        const customPresets = presets.filter((preset) => preset.isCustom) || [];
        const updatedCustomPresets = [...customPresets, newPreset];

        saveCustomPresets(updatedCustomPresets);
        setSaveDialogOpen(false);
        setNewPresetName("");
        setNewPresetDescription("");
    };

    const handleDeletePreset = async (presetToDelete: ExportPreset) => {
        const confirmed = await confirm({
            title: "Delete Preset",
            description: `Are you sure you want to delete the preset "${presetToDelete.name}"?`,
            confirmText: "Delete",
        });
        if (confirmed) {
            const customPresets = presets.filter(
                (preset) =>
                    preset.isCustom && preset.name !== presetToDelete.name,
            );
            saveCustomPresets(customPresets);
        }
    };

    const handlePresetExport = (preset: ExportPreset) => {
        const mergedOptions = {
            ...baseOptions,
            ...preset.options,
        };
        onExport(mergedOptions);
    };

    const customPresets = presets.filter((preset) => preset.isCustom);
    const defaultPresets = presets.filter((preset) => !preset.isCustom);

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
                        onClick={() => setSaveDialogOpen(true)}
                        className="cursor-pointer"
                    >
                        <Save className="mr-2 h-4 w-4" />
                        Save Settings as Preset
                    </DropdownMenuItem>

                    <DropdownMenuSeparator />

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

                    {customPresets.length > 0 && (
                        <>
                            <DropdownMenuSeparator />
                            <DropdownMenuLabel>
                                Custom Presets
                            </DropdownMenuLabel>
                            {customPresets.map((preset, index) => (
                                <DropdownMenuItem
                                    key={`custom-${index}`}
                                    className="flex justify-between"
                                >
                                    <div
                                        className="flex-1 cursor-pointer"
                                        onClick={() =>
                                            handlePresetExport(preset)
                                        }
                                    >
                                        <div className="flex flex-col">
                                            <span>{preset.name}</span>
                                            <span className="text-muted-foreground text-xs">
                                                {preset.description}
                                            </span>
                                        </div>
                                    </div>
                                    <Button
                                        variant="destructive"
                                        size="icon"
                                        className="h-8 w-8"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handleDeletePreset(preset);
                                        }}
                                    >
                                        <Trash2 className="text-primary h-4 w-4" />
                                    </Button>
                                </DropdownMenuItem>
                            ))}
                        </>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>

            <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Save Export Preset</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor="preset-name">Preset Name</Label>
                            <Input
                                id="preset-name"
                                value={newPresetName}
                                onChange={(e) =>
                                    setNewPresetName(e.target.value)
                                }
                                placeholder="My Custom Preset"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="preset-description">
                                Description (optional)
                            </Label>
                            <Input
                                id="preset-description"
                                value={newPresetDescription}
                                onChange={(e) =>
                                    setNewPresetDescription(e.target.value)
                                }
                                placeholder="Custom settings for specific use case"
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setSaveDialogOpen(false)}
                        >
                            Cancel
                        </Button>
                        <Button onClick={handleSavePreset}>Save Preset</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
