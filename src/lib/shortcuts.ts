import { isMac } from "@/lib/utils";

export function displayToken(token: string): string {
    switch (token.toLowerCase()) {
        case "mod":
            return isMac() ? "⌘" : "Ctrl";
        case "ctrl":
            return isMac() ? "⌃" : "Ctrl";
        case "shift":
            return "⇧";
        case "alt":
            return isMac() ? "⌥" : "Alt";
        case "meta":
            return "⌘";
        default:
            return token.length === 1 ? token.toUpperCase() : token;
    }
}

export function splitChord(chord: string): string[] {
    return chord
        .split("+")
        .map((part) => part.trim())
        .filter(Boolean);
}
