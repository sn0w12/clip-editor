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
