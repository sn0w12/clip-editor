// Define missing types for experimental audio tracks support in Electron
declare global {
    interface AudioTrack {
        id: string;
        kind: string;
        label: string;
        language: string;
        enabled: boolean;
    }

    interface AudioTrackList extends EventTarget {
        readonly length: number;
        getTrackById(id: string): AudioTrack | null;
        [index: number]: AudioTrack;
    }

    // Extend HTMLVideoElement to include audioTracks
    interface HTMLVideoElement {
        audioTracks?: AudioTrackList;
    }
}

export {};
