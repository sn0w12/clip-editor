import { useEffect, useState } from "react";

export function useMediaQuery(query: string): boolean {
    const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
    useEffect(() => {
        const media = window.matchMedia(query);
        const onChange = () => setMatches(media.matches);
        media.addEventListener("change", onChange);
        return () => media.removeEventListener("change", onChange);
    }, [query]);
    return matches;
}

export function useIsMobile() {
    return useMediaQuery("(max-width: 768px)");
}
