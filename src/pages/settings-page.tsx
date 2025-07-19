import React from "react";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSettings } from "@/hooks/use-settings";
import {
    createAllSettingsMaps,
    defaultSettings,
    renderInput,
    resetAllSettingsToDefault,
    Setting,
    useSetting,
} from "@/utils/settings";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import pkg from "../../package.json";
import { assetSrc } from "@/utils/assets";
import { useSticky } from "@/hooks/use-sticky";
import { Tree, TreeItem } from "@/components/ui/tree";
import { useConfirm } from "@/contexts/confirm-context";
import {
    Popover,
    PopoverTrigger,
    PopoverContent,
} from "@/components/ui/popover";
import { TableOfContents } from "lucide-react";

interface HierarchicalGroup {
    settings: Record<string, Setting>;
    subgroups: Record<string, Record<string, Setting>>;
}

export default function SettingsPage() {
    const { settings, setSettings } = useSettings();
    const { confirm } = useConfirm();
    const [stickyRef, isSticky] = useSticky();
    const settingsMaps = createAllSettingsMaps(settings, setSettings);
    const appVersion = pkg.version;
    const [searchQuery, setSearchQuery] = React.useState("");
    const [activeTab, setActiveTab] = React.useState("General");
    const [activeSection, setActiveSection] = React.useState<string | null>(
        null,
    );
    const windowIconsStyle = useSetting("windowIconsStyle");

    const groupedSearchResults = React.useMemo(() => {
        const allSettingsForSearch: Array<{
            group: string;
            key: string;
            setting: Setting;
        }> = [];
        Object.entries(settingsMaps).forEach(([groupName, groupSettings]) => {
            if (groupName.toLowerCase() === "search") return;
            Object.entries(groupSettings).forEach(([key, setting]) => {
                if (key === "label") return;
                allSettingsForSearch.push({
                    group: groupName,
                    key,
                    setting: setting as Setting,
                });
            });
        });

        const q = searchQuery.toLowerCase();
        const searchResults = searchQuery.trim()
            ? allSettingsForSearch.filter(
                  ({ key, setting }) =>
                      key.toLowerCase().includes(q) ||
                      (setting.label &&
                          setting.label.toLowerCase().includes(q)) ||
                      (setting.description &&
                          setting.description.toLowerCase().includes(q)),
              )
            : [];

        const grouped: Record<
            string,
            Array<{ key: string; setting: Setting }>
        > = {};
        searchResults.forEach(({ group, key, setting }) => {
            if (!grouped[group]) grouped[group] = [];
            grouped[group].push({ key, setting });
        });
        return grouped;
    }, [searchQuery, settingsMaps]);

    // Custom renderers for special settings
    const customRenderers = {
        settingsSearch: (
            <>
                <div className="mb-6 flex flex-col gap-2">
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search settings by name, description, or key..."
                        className="border-input focus-visible:ring-ring rounded-md border px-3 py-2 text-base transition outline-none focus-visible:ring-2"
                    />
                </div>
                {(() => {
                    if (searchQuery.trim() === "") {
                        return (
                            <p className="text-muted-foreground text-sm">
                                Enter a search term to find settings.
                            </p>
                        );
                    }
                    if (Object.keys(groupedSearchResults).length === 0) {
                        return (
                            <p className="text-muted-foreground text-sm">
                                No settings found matching your search.
                            </p>
                        );
                    }
                    return (
                        <div className="space-y-8">
                            {Object.entries(groupedSearchResults).map(
                                ([groupName, settingsArr]) => (
                                    <div key={groupName} className="space-y-4">
                                        <h3 className="bg-background sticky top-36 z-20 border-b pb-2 text-lg font-medium">
                                            {groupName}
                                        </h3>
                                        <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:!grid-cols-2 lg:!grid-cols-3 xl:!grid-cols-4">
                                            {settingsArr.map(
                                                ({ key, setting }) => (
                                                    <div
                                                        key={key}
                                                        className="space-y-2"
                                                    >
                                                        <div className="flex flex-col space-y-1">
                                                            <Label
                                                                htmlFor={key}
                                                                className="font-medium"
                                                            >
                                                                {setting.label}
                                                            </Label>
                                                            {setting.description && (
                                                                <p className="text-muted-foreground text-xs">
                                                                    {
                                                                        setting.description
                                                                    }
                                                                </p>
                                                            )}
                                                        </div>
                                                        <div className="mt-1">
                                                            {renderInput(
                                                                key,
                                                                setting as Setting,
                                                                settingsMaps[
                                                                    groupName
                                                                ],
                                                            )}
                                                        </div>
                                                    </div>
                                                ),
                                            )}
                                        </div>
                                    </div>
                                ),
                            )}
                        </div>
                    );
                })()}
            </>
        ),
        appInfo: (
            <div className="space-y-6 pt-4">
                <div className="flex flex-col gap-4">
                    <div className="flex items-center gap-3">
                        <img
                            src={assetSrc("/assets/icons/Icon.png")}
                            className="h-12 w-12"
                        />
                        <div>
                            <h3 className="text-2xl font-bold">Clip Editor</h3>
                            <div className="flex items-center gap-2">
                                <span className="text-muted-foreground">
                                    Version {appVersion}
                                </span>
                                <Badge variant="outline" className="text-xs">
                                    Electron
                                </Badge>
                            </div>
                        </div>
                    </div>
                    <p className="text-muted-foreground">
                        A desktop application for editing, managing, and
                        organizing your video clips. Built with Electron, React,
                        and TypeScript.
                    </p>
                </div>

                <div className="space-y-2">
                    <h4 className="font-medium">Key Features</h4>
                    <Separator />
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <div className="flex items-start gap-2 rounded-md border p-3">
                            <div className="bg-primary/10 mt-0.5 rounded-full p-1">
                                <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    viewBox="0 0 24 24"
                                    fill="currentColor"
                                    className="text-primary h-4 w-4"
                                >
                                    <path d="M4.5 4.5a3 3 0 00-3 3v9a3 3 0 003 3h8.25a3 3 0 003-3v-9a3 3 0 00-3-3H4.5zM19.94 18.75l-2.69-2.69V7.94l2.69-2.69c.944-.945 2.56-.276 2.56 1.06v11.38c0 1.336-1.616 2.005-2.56 1.06z" />
                                </svg>
                            </div>
                            <div>
                                <h5 className="font-medium">
                                    Edit Video Clips
                                </h5>
                                <p className="text-muted-foreground text-sm">
                                    Trim video clips by setting custom start and
                                    end points
                                </p>
                            </div>
                        </div>
                        <div className="flex items-start gap-2 rounded-md border p-3">
                            <div className="bg-primary/10 mt-0.5 rounded-full p-1">
                                <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    viewBox="0 0 24 24"
                                    fill="currentColor"
                                    className="text-primary h-4 w-4"
                                >
                                    <path d="M5.566 4.657A4.505 4.505 0 016.75 4.5h10.5c.41 0 .806.055 1.183.157A3 3 0 0015.75 3h-7.5a3 3 0 00-2.684 1.657zM2.25 12a3 3 0 013-3h13.5a3 3 0 013 3v6a3 3 0 01-3 3H5.25a3 3 0 01-3-3v-6zM5.25 7.5c-.41 0-.806.055-1.184.157A3 3 0 016.75 6h10.5a3 3 0 012.683 1.657A4.505 4.505 0 0018.75 7.5H5.25z" />
                                </svg>
                            </div>
                            <div>
                                <h5 className="font-medium">
                                    Organize Content
                                </h5>
                                <p className="text-muted-foreground text-sm">
                                    Group related clips together with
                                    customizable colored tags
                                </p>
                            </div>
                        </div>
                        <div className="flex items-start gap-2 rounded-md border p-3">
                            <div className="bg-primary/10 mt-0.5 rounded-full p-1">
                                <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    viewBox="0 0 24 24"
                                    fill="currentColor"
                                    className="text-primary h-4 w-4"
                                >
                                    <path d="M11.7 2.805a.75.75 0 01.6 0A60.65 60.65 0 0222.83 8.72a.75.75 0 01-.231 1.337 49.949 49.949 0 00-9.902 3.912l-.003.002-.34.18a.75.75 0 01-.707 0A50.009 50.009 0 007.5 12.174v-.224c0-.131.067-.248.172-.311a54.614 54.614 0 014.653-2.52.75.75 0 00-.65-1.352 56.129 56.129 0 00-4.78 2.589 1.858 1.858 0 00-.859 1.228 49.803 49.803 0 00-4.634-1.527.75.75 0 01-.231-1.337A60.653 60.653 0 0111.7 2.805z" />
                                    <path d="M13.06 15.473a48.45 48.45 0 017.666-3.282c.134 1.414.22 2.843.255 4.285a.75.75 0 01-.46.71 47.878 47.878 0 00-8.105 4.342.75.75 0 01-.832 0 47.877 47.877 0 00-8.104-4.342.75.75 0 01-.461-.71c.035-1.442.121-2.87.255-4.286A48.4 48.4 0 016 13.18v1.27a1.5 1.5 0 00-.14 2.508c-.09.38-.222.753-.397 1.11.452.213.901.434 1.346.661a6.729 6.729 0 00.551-1.608 1.5 1.5 0 00.14-2.67v-.645a48.549 48.549 0 013.44 1.668 2.25 2.25 0 002.12 0z" />
                                    <path d="M4.462 19.462c.42-.419.753-.89 1-1.394.453.213.902.434 1.347.661a6.743 6.743 0 01-1.286 1.794.75.75 0 11-1.06-1.06z" />
                                </svg>
                            </div>
                            <div>
                                <h5 className="font-medium">Game Detection</h5>
                                <p className="text-muted-foreground text-sm">
                                    Automatically categorize clips by game with
                                    Steam integration
                                </p>
                            </div>
                        </div>
                        <div className="flex items-start gap-2 rounded-md border p-3">
                            <div className="bg-primary/10 mt-0.5 rounded-full p-1">
                                <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    viewBox="0 0 24 24"
                                    fill="currentColor"
                                    className="text-primary h-4 w-4"
                                >
                                    <path
                                        fillRule="evenodd"
                                        d="M3 6a3 3 0 013-3h2.25a3 3 0 013 3v2.25a3 3 0 01-3 3H6a3 3 0 01-3-3V6zm9.75 0a3 3 0 013-3H18a3 3 0 013 3v2.25a3 3 0 01-3 3h-2.25a3 3 0 01-3-3V6zM3 15.75a3 3 0 013-3h2.25a3 3 0 013 3V18a3 3 0 01-3 3H6a3 3 0 01-3-3v-2.25zm9.75 0a3 3 0 013-3H18a3 3 0 013 3V18a3 3 0 01-3 3h-2.25a3 3 0 01-3-3v-2.25z"
                                        clipRule="evenodd"
                                    />
                                </svg>
                            </div>
                            <div>
                                <h5 className="font-medium">
                                    Advanced Filtering
                                </h5>
                                <p className="text-muted-foreground text-sm">
                                    Find clips by date, game, or custom groups
                                </p>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="space-y-3">
                    <h4 className="font-medium">Links</h4>
                    <Separator />
                    <div className="flex flex-wrap gap-2">
                        <a
                            href="https://github.com/sn0w12/clip-editor"
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            <Button
                                variant="outline"
                                size="sm"
                                className="gap-2"
                            >
                                <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    width="24"
                                    height="24"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    className="lucide lucide-github h-4 w-4"
                                    aria-hidden="true"
                                >
                                    <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"></path>
                                    <path d="M9 18c-4.51 2-5-2-7-2"></path>
                                </svg>
                                GitHub Repository
                            </Button>
                        </a>
                        <a
                            href="https://github.com/sn0w12/clip-editor/issues"
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            <Button
                                variant="outline"
                                size="sm"
                                className="gap-2"
                            >
                                <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    className="h-4 w-4"
                                >
                                    <circle cx="12" cy="12" r="10" />
                                    <line x1="12" x2="12" y1="8" y2="12" />
                                    <line x1="12" x2="12.01" y1="16" y2="16" />
                                </svg>
                                Report Issues
                            </Button>
                        </a>
                        <a
                            href="https://github.com/sn0w12/clip-editor/releases"
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            <Button
                                variant="outline"
                                size="sm"
                                className="gap-2"
                            >
                                <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    className="h-4 w-4"
                                >
                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                    <polyline points="7 10 12 15 17 10" />
                                    <line x1="12" x2="12" y1="15" y2="3" />
                                </svg>
                                Latest Releases
                            </Button>
                        </a>
                    </div>
                </div>

                <div className="space-y-3">
                    <h4 className="font-medium">Acknowledgments</h4>
                    <Separator />
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                        <a
                            href="https://ffmpeg.org/"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:bg-accent/50 flex items-center justify-center rounded-md border p-3"
                        >
                            <div className="text-center">
                                <h5 className="font-medium">FFmpeg</h5>
                                <p className="text-muted-foreground text-xs">
                                    Video processing
                                </p>
                            </div>
                        </a>
                        <a
                            href="https://www.electronjs.org/"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:bg-accent/50 flex items-center justify-center rounded-md border p-3"
                        >
                            <div className="text-center">
                                <h5 className="font-medium">Electron</h5>
                                <p className="text-muted-foreground text-xs">
                                    Desktop apps
                                </p>
                            </div>
                        </a>
                        <a
                            href="https://ui.shadcn.com/"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:bg-accent/50 flex items-center justify-center rounded-md border p-3"
                        >
                            <div className="text-center">
                                <h5 className="font-medium">shadcn/ui</h5>
                                <p className="text-muted-foreground text-xs">
                                    UI components
                                </p>
                            </div>
                        </a>
                    </div>
                </div>

                <div className="flex items-center justify-center">
                    <div className="text-center">
                        <p className="text-muted-foreground text-xs">
                            © {new Date().getFullYear()} Clip Editor. Licensed
                            under the MIT License.
                        </p>
                    </div>
                </div>
            </div>
        ),
    };

    // Helper to build ToC tree structure for the current tab
    const tocTree = React.useMemo(() => {
        const settingsMap = settingsMaps[activeTab];
        if (!settingsMap) return null;

        // Collect hierarchical groups
        const hierarchicalGroups: Record<string, HierarchicalGroup> = {};
        Object.entries(settingsMap).forEach(([key, setting]) => {
            if (key === "label") return;
            if (setting.groups && setting.groups.length > 0) {
                const parentGroup = setting.groups[0];
                if (!hierarchicalGroups[parentGroup]) {
                    hierarchicalGroups[parentGroup] = {
                        settings: {},
                        subgroups: {},
                    };
                }
                if (setting.groups.length === 1) {
                    hierarchicalGroups[parentGroup].settings[key] = setting;
                } else {
                    // Use all group names after the parent as a joined string for uniqueness
                    const subgroupPath = setting.groups.slice(1).join(" > ");
                    if (
                        !hierarchicalGroups[parentGroup].subgroups[subgroupPath]
                    ) {
                        hierarchicalGroups[parentGroup].subgroups[
                            subgroupPath
                        ] = {};
                    }
                    hierarchicalGroups[parentGroup].subgroups[subgroupPath][
                        key
                    ] = setting;
                }
            }
        });

        // Build tree items
        return Object.entries(hierarchicalGroups).map(
            ([groupName, groupData]) => (
                <TreeItem
                    key={groupName}
                    label={groupName}
                    collapsible={Object.keys(groupData.subgroups).length > 0}
                    defaultCollapsed={false}
                    onClick={() => {
                        const el = document.getElementById(
                            `settings-section-${groupName}`,
                        );
                        if (el) {
                            el.scrollIntoView({
                                behavior: "smooth",
                                block: "start",
                            });
                            setActiveSection(groupName);
                        }
                    }}
                    active={activeSection === groupName}
                >
                    {Object.entries(groupData.subgroups).map(
                        ([subgroupPath]) => (
                            <TreeItem
                                key={subgroupPath}
                                label={subgroupPath}
                                onClick={() => {
                                    const el = document.getElementById(
                                        `settings-subsection-${groupName}__${subgroupPath}`,
                                    );
                                    if (el) {
                                        el.scrollIntoView({
                                            behavior: "smooth",
                                            block: "start",
                                        });
                                        setActiveSection(
                                            `${groupName}__${subgroupPath}`,
                                        );
                                    }
                                }}
                                active={
                                    activeSection ===
                                    `${groupName}__${subgroupPath}`
                                }
                            />
                        ),
                    )}
                </TreeItem>
            ),
        );
    }, [settingsMaps, activeTab, activeSection]);

    return (
        <div className="flex flex-col gap-3 p-4 px-6 pr-4">
            {/* Sticky header and tabs */}
            <div className="bg-background pb-2">
                <div className="flex items-center justify-between">
                    <h1 className="text-3xl font-bold">Settings</h1>
                    <Button
                        variant="destructive"
                        size="sm"
                        className={`relative ${windowIconsStyle === "traditional" ? "" : "right-32"}`}
                        onClick={async () => {
                            await confirm({
                                title: "Reset to Default",
                                description:
                                    "Are you sure you want to reset all settings to their default values? This action cannot be undone.",
                                confirmText: "Reset",
                                cancelText: "Cancel",
                                variant: "destructive",
                            });
                            resetAllSettingsToDefault();
                            setSettings(defaultSettings);
                        }}
                    >
                        Reset to Default
                    </Button>
                </div>
                <Tabs
                    defaultValue="General"
                    value={activeTab}
                    onValueChange={(tab) => {
                        setActiveTab(tab);
                        setActiveSection(null);
                    }}
                    className="w-full"
                >
                    <TabsList
                        ref={stickyRef}
                        className={`bg-background sticky top-0 z-40 py-4 ${isSticky ? "settings-tabs-sticky border-b" : ""}`}
                    >
                        {Object.keys(settingsMaps).map((groupName) => (
                            <TabsTrigger key={groupName} value={groupName}>
                                {groupName}
                            </TabsTrigger>
                        ))}
                    </TabsList>
                    {/* Tab contents below */}
                    {Object.entries(settingsMaps).map(
                        ([groupName, settingsMap]) => (
                            <TabsContent key={groupName} value={groupName}>
                                <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr]">
                                    <Card className="gap-0 pt-0">
                                        {groupName.toLowerCase() !== "about" ? (
                                            // Sticky category header
                                            <CardHeader className="bg-background sticky top-16 z-30 flex flex-row items-center justify-between rounded-xl py-3">
                                                <CardTitle className="w-full">
                                                    <h2 className="w-full border-b pt-3 pb-2 text-2xl font-medium">
                                                        {groupName} Settings
                                                    </h2>
                                                </CardTitle>
                                                {/* ToC Popover Button */}
                                                {tocTree &&
                                                tocTree.length > 0 ? (
                                                    <Popover>
                                                        <PopoverTrigger asChild>
                                                            <Button
                                                                variant="outline"
                                                                size="sm"
                                                                className="absolute top-4 right-6 h-8 w-8 p-0"
                                                                aria-label="Open Table of Contents"
                                                            >
                                                                <TableOfContents className="h-4 w-4" />
                                                            </Button>
                                                        </PopoverTrigger>
                                                        <PopoverContent
                                                            className="w-64 p-0"
                                                            align="end"
                                                            side="bottom"
                                                        >
                                                            <div className="p-2">
                                                                <Tree>
                                                                    {tocTree}
                                                                </Tree>
                                                            </div>
                                                        </PopoverContent>
                                                    </Popover>
                                                ) : null}
                                            </CardHeader>
                                        ) : null}
                                        <CardContent>
                                            {(() => {
                                                // Check if this tab contains only a single custom rendered setting
                                                const customSettingKeys =
                                                    Object.entries(settingsMap)
                                                        .filter(
                                                            ([, setting]) =>
                                                                setting.customRender,
                                                        )
                                                        .map(([key]) => key);
                                                const totalSettingKeys =
                                                    Object.keys(
                                                        settingsMap,
                                                    ).filter(
                                                        (k) => k !== "label",
                                                    );
                                                const onlySingleCustom =
                                                    customSettingKeys.length ===
                                                        1 &&
                                                    totalSettingKeys.length ===
                                                        1;
                                                if (onlySingleCustom) {
                                                    // Render the single custom setting directly, no grid or aside
                                                    const key =
                                                        customSettingKeys[0];
                                                    const setting = settingsMap[
                                                        key
                                                    ] as Setting;
                                                    return (
                                                        <div className="space-y-2">
                                                            <div className="flex flex-col space-y-1">
                                                                <Label
                                                                    htmlFor={
                                                                        key
                                                                    }
                                                                    className="font-medium"
                                                                >
                                                                    {
                                                                        setting.label
                                                                    }
                                                                </Label>
                                                                {setting.description && (
                                                                    <p className="text-muted-foreground text-xs">
                                                                        {
                                                                            setting.description
                                                                        }
                                                                    </p>
                                                                )}
                                                            </div>
                                                            <div className="mt-1">
                                                                {
                                                                    customRenderers[
                                                                        key as keyof typeof customRenderers
                                                                    ]
                                                                }
                                                            </div>
                                                        </div>
                                                    );
                                                }
                                                // Otherwise, render grid and aside as before
                                                return (
                                                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr]">
                                                        {/* Settings content (left) */}
                                                        <div>
                                                            {(() => {
                                                                // First, collect all settings that have groups
                                                                const settingsWithGroups: Record<
                                                                    string,
                                                                    Setting
                                                                > = {};
                                                                const settingsWithoutGroups: Record<
                                                                    string,
                                                                    Setting
                                                                > = {};

                                                                // Separate settings with and without groups
                                                                Object.entries(
                                                                    settingsMap,
                                                                ).forEach(
                                                                    ([
                                                                        key,
                                                                        setting,
                                                                    ]) => {
                                                                        if (
                                                                            key ===
                                                                            "label"
                                                                        )
                                                                            return;

                                                                        if (
                                                                            setting.groups &&
                                                                            setting
                                                                                .groups
                                                                                .length >
                                                                                0
                                                                        ) {
                                                                            settingsWithGroups[
                                                                                key
                                                                            ] =
                                                                                setting as Setting;
                                                                        } else {
                                                                            settingsWithoutGroups[
                                                                                key
                                                                            ] =
                                                                                setting as Setting;
                                                                        }
                                                                    },
                                                                );

                                                                // Create hierarchical structure
                                                                const hierarchicalGroups: Record<
                                                                    string,
                                                                    HierarchicalGroup
                                                                > = {};

                                                                // Process settings with groups
                                                                Object.entries(
                                                                    settingsWithGroups,
                                                                ).forEach(
                                                                    ([
                                                                        key,
                                                                        setting,
                                                                    ]) => {
                                                                        const groups =
                                                                            setting.groups as string[];

                                                                        // Assume the first group is always the parent
                                                                        const parentGroup =
                                                                            groups[0];

                                                                        // Initialize parent group if it doesn't exist
                                                                        if (
                                                                            !hierarchicalGroups[
                                                                                parentGroup
                                                                            ]
                                                                        ) {
                                                                            hierarchicalGroups[
                                                                                parentGroup
                                                                            ] =
                                                                                {
                                                                                    settings:
                                                                                        {},
                                                                                    subgroups:
                                                                                        {},
                                                                                };
                                                                        }

                                                                        if (
                                                                            groups.length ===
                                                                            1
                                                                        ) {
                                                                            // This setting belongs directly to the parent group
                                                                            hierarchicalGroups[
                                                                                parentGroup
                                                                            ].settings[
                                                                                key
                                                                            ] =
                                                                                setting;
                                                                        } else {
                                                                            // This setting belongs to a subgroup
                                                                            for (
                                                                                let i = 1;
                                                                                i <
                                                                                groups.length;
                                                                                i++
                                                                            ) {
                                                                                const subgroup =
                                                                                    groups[
                                                                                        i
                                                                                    ];

                                                                                // Initialize subgroup if it doesn't exist
                                                                                if (
                                                                                    !hierarchicalGroups[
                                                                                        parentGroup
                                                                                    ]
                                                                                        .subgroups[
                                                                                        subgroup
                                                                                    ]
                                                                                ) {
                                                                                    hierarchicalGroups[
                                                                                        parentGroup
                                                                                    ].subgroups[
                                                                                        subgroup
                                                                                    ] =
                                                                                        {};
                                                                                }

                                                                                // Add setting to subgroup
                                                                                hierarchicalGroups[
                                                                                    parentGroup
                                                                                ].subgroups[
                                                                                    subgroup
                                                                                ][
                                                                                    key
                                                                                ] =
                                                                                    setting;
                                                                            }
                                                                        }
                                                                    },
                                                                );

                                                                // Function to render a group of settings
                                                                const renderSettingsGroup =
                                                                    (
                                                                        groupSettings: Record<
                                                                            string,
                                                                            Setting
                                                                        >,
                                                                    ) => {
                                                                        return (
                                                                            <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:!grid-cols-2 lg:!grid-cols-3 xl:!grid-cols-4">
                                                                                {Object.entries(
                                                                                    groupSettings,
                                                                                ).map(
                                                                                    ([
                                                                                        key,
                                                                                        setting,
                                                                                    ]) => {
                                                                                        // For certain settings that should span the full width
                                                                                        const isFullWidth =
                                                                                            setting.customRender ||
                                                                                            setting.type ===
                                                                                                "textarea" ||
                                                                                            groupName.toLowerCase() ===
                                                                                                "about";

                                                                                        return (
                                                                                            <div
                                                                                                key={
                                                                                                    key
                                                                                                }
                                                                                                className={`space-y-2 ${isFullWidth ? "col-span-full" : ""}`}
                                                                                            >
                                                                                                <div className="flex flex-col space-y-1">
                                                                                                    <Label
                                                                                                        htmlFor={
                                                                                                            key
                                                                                                        }
                                                                                                        className="font-medium"
                                                                                                    >
                                                                                                        {
                                                                                                            setting.label
                                                                                                        }
                                                                                                    </Label>
                                                                                                    {setting.description && (
                                                                                                        <p className="text-muted-foreground text-xs">
                                                                                                            {
                                                                                                                setting.description
                                                                                                            }
                                                                                                        </p>
                                                                                                    )}
                                                                                                </div>
                                                                                                <div className="mt-1">
                                                                                                    {setting.customRender
                                                                                                        ? customRenderers[
                                                                                                              key as keyof typeof customRenderers
                                                                                                          ]
                                                                                                        : renderInput(
                                                                                                              key,
                                                                                                              setting as Setting,
                                                                                                              settingsMap,
                                                                                                          )}
                                                                                                </div>
                                                                                            </div>
                                                                                        );
                                                                                    },
                                                                                )}
                                                                            </div>
                                                                        );
                                                                    };

                                                                return (
                                                                    <div className="space-y-8">
                                                                        {/* Render ungrouped settings first if they exist */}
                                                                        {Object.keys(
                                                                            settingsWithoutGroups,
                                                                        )
                                                                            .length >
                                                                            0 && (
                                                                            <div className="space-y-4">
                                                                                {renderSettingsGroup(
                                                                                    settingsWithoutGroups,
                                                                                )}
                                                                            </div>
                                                                        )}

                                                                        {/* Render hierarchical groups */}
                                                                        {Object.entries(
                                                                            hierarchicalGroups,
                                                                        ).map(
                                                                            ([
                                                                                groupName,
                                                                                groupData,
                                                                            ]) => (
                                                                                <div
                                                                                    key={
                                                                                        groupName
                                                                                    }
                                                                                    className="space-y-4"
                                                                                    id={`settings-section-${groupName}`}
                                                                                    style={{
                                                                                        scrollMarginTop:
                                                                                            "150px",
                                                                                    }} // adjust for sticky header
                                                                                >
                                                                                    {/* Sticky main group header */}
                                                                                    <h3 className="bg-background sticky top-34 z-20 border-b pb-2 text-lg font-medium">
                                                                                        {
                                                                                            groupName
                                                                                        }
                                                                                    </h3>

                                                                                    {/* Main group settings */}
                                                                                    {Object.keys(
                                                                                        groupData.settings,
                                                                                    )
                                                                                        .length >
                                                                                        0 &&
                                                                                        renderSettingsGroup(
                                                                                            groupData.settings,
                                                                                        )}

                                                                                    {/* Subgroups */}
                                                                                    {Object.entries(
                                                                                        groupData.subgroups,
                                                                                    ).map(
                                                                                        ([
                                                                                            subgroupPath,
                                                                                            subgroupSettings,
                                                                                        ]) => (
                                                                                            <div
                                                                                                key={
                                                                                                    subgroupPath
                                                                                                }
                                                                                                className="border-muted mt-6 space-y-4 border-l-2 pt-1 pl-4"
                                                                                                id={`settings-subsection-${groupName}__${subgroupPath}`}
                                                                                                style={{
                                                                                                    scrollMarginTop:
                                                                                                        "170px",
                                                                                                }}
                                                                                            >
                                                                                                {/* Sticky subgroup header */}
                                                                                                <h4 className="text-md bg-background sticky top-43 z-10 flex items-center pt-1 font-medium">
                                                                                                    {
                                                                                                        subgroupPath
                                                                                                    }
                                                                                                </h4>

                                                                                                {/* Subgroup settings */}
                                                                                                {renderSettingsGroup(
                                                                                                    subgroupSettings,
                                                                                                )}
                                                                                            </div>
                                                                                        ),
                                                                                    )}
                                                                                </div>
                                                                            ),
                                                                        )}
                                                                    </div>
                                                                );
                                                            })()}
                                                        </div>
                                                        {/* Table of Contents (right, inside card) */}
                                                    </div>
                                                );
                                            })()}
                                        </CardContent>
                                    </Card>
                                </div>
                            </TabsContent>
                        ),
                    )}
                </Tabs>
            </div>
        </div>
    );
}
