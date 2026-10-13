import { visibleSettings } from "@/hooks/settings/use-setting";
import type { SettingsSection } from "@/lib/backend/protocol";

import { FramePanel } from "../ui/frame";
import { Separator } from "../ui/separator";
import { SettingField } from "./setting-field";

export function SettingsSectionCard({ section }: { section: SettingsSection }) {
    const definitions = visibleSettings(section);
    if (definitions.length === 0) return null;

    return (
        <FramePanel>
            <h3 className="pb-1 text-xl font-semibold">{section.title}</h3>
            <Separator className="mb-2" />
            <div className="space-y-4">
                {definitions.map((definition) => (
                    <SettingField
                        key={definition.key}
                        definition={definition}
                    />
                ))}
            </div>
        </FramePanel>
    );
}
