/**
 * Shared Audio Context Manager
 *
 * This utility provides a singleton AudioContext and manages shared MediaElementSourceNodes
 * to allow multiple audio visualizers to connect to the same audio/video element
 * without causing the "already connected" error.
 */

// Map to store media elements and their source nodes
type MediaSourceMap = Map<HTMLMediaElement, MediaElementAudioSourceNode>;

// Singleton instance
let sharedAudioContext: AudioContext | null = null;
const mediaSourceNodes: MediaSourceMap = new Map();

/**
 * Get or create the shared AudioContext
 */
export function getAudioContext(): AudioContext {
    if (!sharedAudioContext) {
        sharedAudioContext = new AudioContext();
    }
    return sharedAudioContext;
}

/**
 * Get or create a MediaElementSourceNode for a media element
 *
 * This ensures we only create one source node per media element,
 * allowing multiple visualizers to connect to the same source.
 */
export function getMediaElementSource(
    mediaElement: HTMLMediaElement,
): MediaElementAudioSourceNode {
    // If we already have a source node for this element, return it
    if (mediaSourceNodes.has(mediaElement)) {
        return mediaSourceNodes.get(mediaElement)!;
    }

    // Create a new source node
    const ctx = getAudioContext();
    const sourceNode = ctx.createMediaElementSource(mediaElement);

    // Connect the source to the destination to ensure audio still plays
    sourceNode.connect(ctx.destination);

    // Store the source node for reuse
    mediaSourceNodes.set(mediaElement, sourceNode);

    return sourceNode;
}

/**
 * Clean up source node for a media element
 */
export function cleanupMediaElementSource(
    mediaElement: HTMLMediaElement,
): void {
    if (mediaSourceNodes.has(mediaElement)) {
        try {
            const sourceNode = mediaSourceNodes.get(mediaElement)!;
            sourceNode.disconnect();
            mediaSourceNodes.delete(mediaElement);
        } catch (e) {
            console.error("Error cleaning up media element source:", e);
        }
    }
}

/**
 * Dispose of the audio context and all source nodes
 */
export function disposeAudioContext(): void {
    if (sharedAudioContext) {
        // Disconnect all source nodes
        mediaSourceNodes.forEach((sourceNode) => {
            try {
                sourceNode.disconnect();
            } catch (e) {
                console.error("Error disconnecting source node:", e);
            }
        });

        // Clear the map
        mediaSourceNodes.clear();

        // Close the audio context
        try {
            sharedAudioContext.close();
        } catch (e) {
            console.error("Error closing audio context:", e);
        }

        sharedAudioContext = null;
    }
}
