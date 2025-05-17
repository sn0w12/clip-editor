import { platform } from "@/platform";
import { useSetting } from "@/utils/settings";
import React from "react";

export function TopRight() {
    const windowIconsStyle = useSetting("windowIconsStyle");
    if (windowIconsStyle === "traditional" || platform.isWeb()) {
        return null;
    }

    return (
        <div className="pointer-events-none fixed top-0 right-0 z-40 h-16 w-40">
            <div className="group pointer-events-none absolute top-8 z-40 -mb-8 h-24 w-full origin-top">
                <svg
                    className="absolute -right-8 h-7 origin-top-left skew-x-[30deg] overflow-visible"
                    version="1.1"
                    xmlns="http://www.w3.org/2000/svg"
                    xmlnsXlink="http://www.w3.org/1999/xlink"
                    viewBox="0 0 220 32"
                    xmlSpace="preserve"
                >
                    <line
                        stroke="var(--sidebar)"
                        strokeWidth="2px"
                        shapeRendering="optimizeQuality"
                        vectorEffect="non-scaling-stroke"
                        strokeLinecap="round"
                        strokeMiterlimit="10"
                        x1="1"
                        y1="0"
                        x2="220"
                        y2="0"
                    ></line>
                    <path
                        className="translate-y-[0.5px]"
                        fill="var(--sidebar)"
                        shapeRendering="optimizeQuality"
                        strokeWidth="1px"
                        strokeLinecap="round"
                        strokeMiterlimit="10"
                        vectorEffect="non-scaling-stroke"
                        d="M0,0c5.9,0,10.7,3.6,10.7,8v8c0,4.4,4.8,8,10.7,8H220V0"
                        stroke="var(--border)"
                    ></path>
                </svg>
            </div>
        </div>
    );
}
