export interface VideoMetadata {
    duration: number;
    width: number;
    height: number;
    fps: number;
    bitrate?: number;
    size?: number;
    videoCodec?: string;
    audioCodec?: string;
}

export interface ExportOptions {
    startTime: number; // Start time in seconds
    endTime: number; // End time in seconds
    outputFormat: string; // e.g., 'mp4', 'webm'
    quality?: string; // e.g., 'high', 'medium', 'low'
    targetSize?: number; // Target file size in MB
    qualityMode: "preset" | "targetSize"; // Whether to use quality preset or target size
    width?: number; // Optional width
    height?: number; // Optional height
    fps?: number; // Optional fps
    audioBitrate?: number; // Optional audio bitrate
    removeAudio?: boolean; // Optional flag to remove audio
    speedFactor?: number; // Optional playback speed adjustment
    audioTracks?: number[]; // Optional array of audio track indices to include
    chooseExportLocation?: boolean; // Optional flag to choose export location
}

export interface TimeRange {
    start: number;
    end: number;
}
