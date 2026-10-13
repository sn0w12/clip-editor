import { platform } from "@tauri-apps/plugin-os";
import { clsx } from "clsx";
import type { ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
    return twMerge(clsx(inputs));
}

export function isMac(): boolean {
    try {
        return platform() === "macos";
    } catch (e) {
        console.error("platform check failed", e);
        return navigator.userAgent.toLowerCase().includes("mac");
    }
}

export function isWindows(): boolean {
    try {
        return platform() === "windows";
    } catch (e) {
        console.error("platform check failed", e);
        return navigator.userAgent.toLowerCase().includes("win");
    }
}

/** Strip the Windows extended-length `\\?\` prefix for display. */
export function displayPath(path: string): string {
    return path.replace(/^\\\\\?\\/, "");
}

export function capitalize(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

/** `2026-08-10T12:00:00Z` becomes `Aug 10, 2026`. */
export function formatRelativeDate(dateString: string): string {
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return dateString;
    return new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
    }).format(date);
}

export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(
        Math.floor(Math.log(bytes) / Math.log(1024)),
        units.length - 1
    );
    const value = bytes / 1024 ** i;
    return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** `125.4` becomes `2:05`. */
export function formatDuration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const total = Math.round(seconds);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Short date key for grouping clips by day: `2026-08-10`. */
export function dateKey(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
    const y = date.getFullYear();
    const m = (date.getMonth() + 1).toString().padStart(2, "0");
    const d = date.getDate().toString().padStart(2, "0");
    return `${y}-${m}-${d}`;
}

export function stringToColor(str: string): string {
    let hash = 0;
    for (const char of str) {
        hash = char.charCodeAt(0) + ((hash << 5) - hash);
    }
    let color = "#";
    for (let i = 0; i < 3; i += 1) {
        const value = (hash >> (i * 8)) & 0xff;
        color += value.toString(16).padStart(2, "0");
    }
    return color;
}
