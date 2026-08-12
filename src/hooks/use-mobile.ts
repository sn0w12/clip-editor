import { useIsMobile } from "./use-media-query";

export { useIsMobile };

/** Alias kept for Akari-copied components expecting `useMobile`. */
export function useMobile() {
    return useIsMobile();
}
