import { useEffect, useRef, useState } from "react";

/**
 * useSticky hook detects if an element is currently "stuck" due to CSS position: sticky.
 * Returns a ref to attach to the sticky element and a boolean indicating if it's stuck.
 */
export function useSticky(
    offset: number = 0,
): [React.RefObject<HTMLDivElement | null>, boolean] {
    const ref = useRef<HTMLDivElement>(null);
    const [isSticky, setIsSticky] = useState(false);

    useEffect(() => {
        const element = ref.current;
        if (!element) {
            console.log("Sticky ref not attached to any element.");
            return;
        }

        const stickyTop = parseInt(
            window.getComputedStyle(element).top || "0",
            10,
        );

        const sentinel = document.createElement("div");
        sentinel.style.position = "absolute";
        sentinel.style.left = "0";
        sentinel.style.width = "1px";
        sentinel.style.height = "1px";
        sentinel.style.top = `${stickyTop - 2 + offset}px`;

        if (element.parentElement) {
            element.parentElement.insertBefore(sentinel, element.nextSibling);
        }

        const observer = new window.IntersectionObserver(
            ([entry]) => {
                setIsSticky(!entry.isIntersecting);
            },
            {
                root: null,
                threshold: 0,
            },
        );

        observer.observe(sentinel);

        return () => {
            observer.disconnect();
            sentinel.remove();
        };
    }, []);

    return [ref, isSticky];
}
