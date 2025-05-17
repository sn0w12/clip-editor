import React from "react";
import { Label } from "@/components/ui/label";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSettings } from "@/hooks/use-settings";
import { createAllSettingsMaps, renderInput } from "@/utils/settings";
import pkg from "../../package.json";

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
                            <Card
                                className={`${groupName.toLowerCase() !== "about" ? "" : "gap-0"}`}
                            >
                                <CardHeader className="pb-3">
                                    {groupName.toLowerCase() !== "about" ? (
                                        <>
                                            <CardTitle>
                                                {groupName} Settings
                                            </CardTitle>
                                            <CardDescription>
                                                Configure{" "}
                                                {groupName.toLowerCase()}{" "}
                                                settings{" "}
                                            </CardDescription>
                                        </>
                                    ) : (
                                        <CardTitle>{groupName}</CardTitle>
                                    )}
                                </CardHeader>
                                <CardContent>
                                    <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:!grid-cols-2 lg:!grid-cols-3 xl:!grid-cols-4">
                                        {Object.entries(settingsMap).map(
                                            ([key, setting]) => {
                                                if (key === "label")
                                                    return null;

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
                                                            {setting.customRender
                                                                ? customRenderers[
                                                                      key as keyof typeof customRenderers
                                                                  ]
                                                                : renderInput(
                                                                      key,
                                                                      setting,
                                                                      settingsMap,
                                                                  )}
                                                        </div>
                                                    </div>
                                                );
                                            },
                                        )}
                                    </div>
                                </CardContent>
                            </Card>
                        </TabsContent>
                    ),
                )}
            </Tabs>
        </div>
    );
}
