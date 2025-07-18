/**
 * Formats a file size in bytes to a human-readable string with appropriate unit
 * @param bytes The file size in bytes
 * @param decimals The number of decimal places to show (default: 2)
 * @returns A formatted string representing the file size (e.g., "1.5 MB")
 */
export function formatFileSize(bytes: number, decimals: number = 2): string {
    if (bytes === 0) return "0 Bytes";

    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (
        parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + " " + sizes[i]
    );
}

/**
 * Formats a time in seconds to a human-readable string
 * @param timeInSeconds The time in seconds
 * @param options Configuration options for the formatting
 * @returns A formatted time string
 */
export function formatTime(
    timeInSeconds: number,
    options: {
        showMilliseconds?: boolean;
        showHours?: boolean;
        padZeros?: boolean;
        separator?: string;
        msSeparator?: string;
    } = {},
): string {
    const {
        showMilliseconds = false,
        showHours = false,
        padZeros = true,
        separator = ":",
        msSeparator = ".",
    } = options;

    const hours = showHours ? Math.floor(timeInSeconds / 3600) : 0;
    const minutes = Math.floor((timeInSeconds % 3600) / 60);
    const seconds = Math.floor(timeInSeconds % 60);
    const ms = Math.floor((timeInSeconds % 1) * 100);

    const pad = (num: number, size: number): string =>
        padZeros ? num.toString().padStart(size, "0") : num.toString();

    let result = "";

    if (showHours || hours > 0) {
        result += pad(hours, 2) + separator;
    }

    result += pad(minutes, 2) + separator + pad(seconds, 2);

    if (showMilliseconds) {
        result += msSeparator + pad(ms, 2);
    }

    return result;
}

export function formatDate(date: Date | string): string {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);

    let formattedDate;
    if (typeof date === "string") {
        formattedDate = new Date(date);
    } else {
        formattedDate = date;
    }

    if (formattedDate.toDateString() === today.toDateString()) {
        formattedDate = "Today";
    } else if (formattedDate.toDateString() === yesterday.toDateString()) {
        formattedDate = "Yesterday";
    } else {
        formattedDate = formattedDate.toLocaleDateString("en-US", {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
        });
    }
    return formattedDate;
}
