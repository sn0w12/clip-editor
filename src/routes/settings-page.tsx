"use no memo";

import { motion } from "motion/react";
import { useLayoutEffect, useRef, useState } from "react";

import { AboutCard } from "@/components/settings/about-card";
import { RecordingSettings } from "@/components/settings/recording-settings";
import { Frame } from "@/components/ui/frame";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsPanel, TabsTrigger } from "@/components/ui/tabs";
import {
    useSettingsSchema,
    visibleSettings,
} from "@/hooks/settings/use-setting";
import { EASE_OUT } from "@/lib/motion";

import { SettingsSectionCard } from "../components/settings/settings-section";

// Everything renders from the Rust-defined schema. The last tab, About, is
// hardcoded in the frontend because it is not a setting.
export function SettingsPage() {
    const [selectedTabId, setSelectedTabId] = useState<string | null>(null);
    const schema = useSettingsSchema();
    const contentRef = useRef<HTMLDivElement>(null);
    const [contentHeight, setContentHeight] = useState<number>();

    useLayoutEffect(() => {
        const element = contentRef.current;
        if (!element) return;

        const updateHeight = () => {
            setContentHeight(element.scrollHeight);
        };

        updateHeight();

        const observer = new ResizeObserver(updateHeight);
        observer.observe(element);

        return () => observer.disconnect();
    }, [selectedTabId]);

    if (schema.tabs.length === 0) {
        return (
            <div className="flex h-full items-center justify-center p-6">
                <p className="text-sm text-muted-foreground">
                    No settings available.
                </p>
            </div>
        );
    }

    const aboutTab = { id: "about", label: "About" };
    const recordingTab = { id: "recording", label: "Recording" };
    const tabs = [...schema.tabs, recordingTab, aboutTab];
    const activeTabId = selectedTabId ?? tabs[0].id;

    return (
        <ScrollArea className="h-full" scrollX={false}>
            <Tabs
                className="container h-full min-h-0 p-2"
                orientation="vertical"
                value={activeTabId}
                onValueChange={(value) => {
                    if (typeof value === "string") setSelectedTabId(value);
                }}
                data-slot="settings-page"
            >
                <TabsList
                    className="sticky top-2 h-fit w-44 shrink-0 p-1"
                    aria-label="Settings"
                >
                    {tabs.map((tab) => (
                        <TabsTrigger
                            key={tab.id}
                            value={tab.id}
                            className="data-[orientation=vertical]:justify-center"
                        >
                            {tab.label}
                        </TabsTrigger>
                    ))}
                </TabsList>
                <Frame className="ui-selectable w-full">
                    <motion.div
                        animate={{ height: contentHeight }}
                        transition={{
                            duration: 0.35,
                            ease: EASE_OUT,
                        }}
                        style={{ overflow: "hidden" }}
                    >
                        <div ref={contentRef}>
                            {schema.tabs.map((tab) => (
                                <TabsPanel
                                    key={tab.id}
                                    value={tab.id}
                                    className="min-h-0 space-y-1"
                                >
                                    {tab.sections.map((section) =>
                                        visibleSettings(section).length > 0 ? (
                                            <SettingsSectionCard
                                                key={section.id}
                                                section={section}
                                            />
                                        ) : null
                                    )}
                                </TabsPanel>
                            ))}
                            <TabsPanel
                                value={recordingTab.id}
                                className="min-h-0 space-y-1"
                            >
                                <RecordingSettings />
                            </TabsPanel>
                            <TabsPanel
                                value={aboutTab.id}
                                className="min-h-0 space-y-1"
                            >
                                <AboutCard />
                            </TabsPanel>
                        </div>
                    </motion.div>
                </Frame>
            </Tabs>
        </ScrollArea>
    );
}
