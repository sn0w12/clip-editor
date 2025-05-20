import React from "react";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSettings } from "@/hooks/use-settings";
import { createAllSettingsMaps, renderInput, Setting } from "@/utils/settings";
import pkg from "../../package.json";

interface HierarchicalGroup {
    settings: Record<string, Setting>;
    subgroups: Record<string, Record<string, Setting>>;
}

export default function SettingsPage() {
    const { settings, setSettings } = useSettings();
    const settingsMaps = createAllSettingsMaps(settings, setSettings);
    const appVersion = pkg.version;

    // Custom renderers for special settings
    const customRenderers = {
        appInfo: (
            <div className="space-y-4">
                <div className="flex flex-col gap-1 text-sm">
                    <p>Version: {appVersion}</p>
                    <a
                        href="https://github.com/sn0w12/clip-editor"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-accent-positive flex items-center hover:underline"
                    >
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            fill="currentColor"
                            className="mr-1 h-4 w-4"
                        >
                            <path d="M12 .587l3.668 7.568 8.332 1.151-6.064 5.828 1.48 8.279-7.416-3.967-7.417 3.967 1.481-8.279-6.064-5.828 8.332-1.151z" />
                        </svg>
                        If you find this tool helpful, please consider giving it
                        a star!
                    </a>
                </div>
            </div>
        ),
    };

    return (
        <div className="flex flex-col gap-3 p-4 px-6">
            <h1 className="text-3xl font-bold">Settings</h1>

            <Tabs defaultValue="General" className="w-full">
                <TabsList className="mb-4">
                    {Object.keys(settingsMaps).map((groupName) => (
                        <TabsTrigger key={groupName} value={groupName}>
                            {groupName}
                        </TabsTrigger>
                    ))}
                </TabsList>

                {/* Render all settings tabs from settings maps */}
                {Object.entries(settingsMaps).map(
                    ([groupName, settingsMap]) => (
                        <TabsContent key={groupName} value={groupName}>
                            <Card className={`gap-0`}>
                                <CardHeader className="pb-3">
                                    {groupName.toLowerCase() !== "about" ? (
                                        <CardTitle>
                                            <h2 className="border-b pb-2 text-2xl font-medium">
                                                {groupName} Settings
                                            </h2>
                                        </CardTitle>
                                    ) : (
                                        <CardTitle>{groupName}</CardTitle>
                                    )}
                                </CardHeader>{" "}
                                <CardContent>
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
                                        Object.entries(settingsMap).forEach(
                                            ([key, setting]) => {
                                                if (key === "label") return;

                                                if (
                                                    setting.groups &&
                                                    setting.groups.length > 0
                                                ) {
                                                    settingsWithGroups[key] =
                                                        setting as Setting;
                                                } else {
                                                    settingsWithoutGroups[key] =
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
                                        ).forEach(([key, setting]) => {
                                            const groups =
                                                setting.groups as string[];

                                            // Assume the first group is always the parent
                                            const parentGroup = groups[0];

                                            // Initialize parent group if it doesn't exist
                                            if (
                                                !hierarchicalGroups[parentGroup]
                                            ) {
                                                hierarchicalGroups[
                                                    parentGroup
                                                ] = {
                                                    settings: {},
                                                    subgroups: {},
                                                };
                                            }

                                            if (groups.length === 1) {
                                                // This setting belongs directly to the parent group
                                                hierarchicalGroups[
                                                    parentGroup
                                                ].settings[key] = setting;
                                            } else {
                                                // This setting belongs to a subgroup
                                                for (
                                                    let i = 1;
                                                    i < groups.length;
                                                    i++
                                                ) {
                                                    const subgroup = groups[i];

                                                    // Initialize subgroup if it doesn't exist
                                                    if (
                                                        !hierarchicalGroups[
                                                            parentGroup
                                                        ].subgroups[subgroup]
                                                    ) {
                                                        hierarchicalGroups[
                                                            parentGroup
                                                        ].subgroups[subgroup] =
                                                            {};
                                                    }

                                                    // Add setting to subgroup
                                                    hierarchicalGroups[
                                                        parentGroup
                                                    ].subgroups[subgroup][key] =
                                                        setting;
                                                }
                                            }
                                        });

                                        // Function to render a group of settings
                                        const renderSettingsGroup = (
                                            groupSettings: Record<
                                                string,
                                                Setting
                                            >,
                                        ) => {
                                            return (
                                                <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:!grid-cols-2 lg:!grid-cols-3 xl:!grid-cols-4">
                                                    {Object.entries(
                                                        groupSettings,
                                                    ).map(([key, setting]) => {
                                                        // For certain settings that should span the full width
                                                        const isFullWidth =
                                                            setting.customRender ||
                                                            setting.type ===
                                                                "textarea" ||
                                                            groupName.toLowerCase() ===
                                                                "about";

                                                        return (
                                                            <div
                                                                key={key}
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
                                                    })}
                                                </div>
                                            );
                                        };

                                        return (
                                            <div className="space-y-8">
                                                {/* Render ungrouped settings first if they exist */}
                                                {Object.keys(
                                                    settingsWithoutGroups,
                                                ).length > 0 && (
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
                                                            key={groupName}
                                                            className="space-y-4"
                                                        >
                                                            {/* Main group header */}
                                                            <h3 className="border-b pb-2 text-lg font-medium">
                                                                {groupName}
                                                            </h3>

                                                            {/* Main group settings */}
                                                            {Object.keys(
                                                                groupData.settings,
                                                            ).length > 0 &&
                                                                renderSettingsGroup(
                                                                    groupData.settings,
                                                                )}

                                                            {/* Subgroups */}
                                                            {Object.entries(
                                                                groupData.subgroups,
                                                            ).map(
                                                                ([
                                                                    subgroupName,
                                                                    subgroupSettings,
                                                                ]) => (
                                                                    <div
                                                                        key={
                                                                            subgroupName
                                                                        }
                                                                        className="border-muted mt-6 space-y-4 border-l-2 pt-1 pl-4"
                                                                    >
                                                                        {/* Subgroup header */}
                                                                        <h4 className="text-md flex items-center font-medium">
                                                                            {
                                                                                subgroupName
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
                                </CardContent>
                            </Card>
                        </TabsContent>
                    ),
                )}
            </Tabs>
        </div>
    );
}
