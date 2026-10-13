import { useQuery } from "@tanstack/react-query";

import { FramePanel } from "@/components/ui/frame";
import { Separator } from "@/components/ui/separator";
import { useAppServices } from "@/contexts/services-context";
import { appInfoQuery } from "@/lib/backend/queries/app-queries";

interface AboutEntry {
    label: string;
    value: string | undefined;
}

export function AboutCard() {
    const { backend } = useAppServices();
    const info = useQuery(appInfoQuery({ backend }));

    const entries: AboutEntry[] = [
        { label: "Version", value: info.data?.version },
        { label: "Identifier", value: info.data?.identifier },
        {
            label: "Platform",
            value: info.data ? `${info.data.os} ${info.data.arch}` : undefined,
        },
        { label: "Tauri", value: info.data?.tauriVersion },
    ];

    return (
        <FramePanel data-slot="settings-about">
            <h3 className="pb-1 text-xl font-semibold">About</h3>
            <Separator className="mb-2" />
            <div className="space-y-4">
                <div className="space-y-1 text-sm">
                    {entries.map((entry) => (
                        <div key={entry.label} className="space-y-1 text-sm">
                            <div className="font-medium">{entry.label}</div>
                            <div className="font-mono text-muted-foreground">
                                {entry.value ?? "-"}
                            </div>
                        </div>
                    ))}
                </div>
                <p className="text-sm text-muted-foreground">
                    Put your licenses and third-party credits here.
                </p>
            </div>
        </FramePanel>
    );
}
