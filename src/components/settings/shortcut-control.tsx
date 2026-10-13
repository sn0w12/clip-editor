import { useHotkeyRecorder } from "@tanstack/react-hotkeys";
import { X } from "lucide-react";
import { Fragment } from "react";

import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { displayToken, splitChord } from "@/lib/shortcuts";

import { ButtonGroup } from "../ui/group";

function Chord({ chord }: { chord: string }) {
    const parts = splitChord(chord);

    if (parts.length === 0) return null;

    return (
        <KbdGroup>
            {parts.map((part, index) => (
                <Fragment key={`${part}-${index}`}>
                    <Kbd>{displayToken(part)}</Kbd>
                </Fragment>
            ))}
        </KbdGroup>
    );
}

/**
 * Shortcut editor backed by TanStack Hotkey's recorder: click edit, press a
 * chord, done. Backspace/Delete while recording clears the binding.
 */
export function ShortcutControl({
    value,
    onChange,
}: {
    value: string;
    onChange: (value: string) => void;
}) {
    const recorder = useHotkeyRecorder({
        onRecord: (hotkey) => {
            onChange(typeof hotkey === "string" ? hotkey.trim() : "");
        },
    });

    if (recorder.isRecording) {
        return (
            <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                    Press keys…
                </span>
                <Button
                    variant="outline"
                    onClick={() => recorder.cancelRecording()}
                >
                    Cancel
                </Button>
            </div>
        );
    }

    return (
        <div className="flex items-center gap-2">
            {value ? (
                <Chord chord={value} />
            ) : (
                <span className="text-xs text-muted-foreground">Not set</span>
            )}
            <ButtonGroup>
                <Button
                    variant="outline"
                    onClick={() => recorder.startRecording()}
                >
                    Edit
                </Button>
                {value && (
                    <Button
                        variant="destructive"
                        size="icon"
                        aria-label="Clear shortcut"
                        onClick={() => onChange("")}
                        render={
                            <span role="button">
                                <X />
                            </span>
                        }
                    />
                )}
            </ButtonGroup>
        </div>
    );
}
