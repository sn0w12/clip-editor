import * as React from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Copy, Check } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";

import Prism from "prismjs";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-css";
import "prismjs/components/prism-json";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-bash";
import "prismjs/themes/prism-tomorrow.css";

import { cn } from "@/utils/tailwind";

function CopyButton({ children }: { children: React.ReactNode }) {
    const [isCopied, setIsCopied] = React.useState(false);

    const handleCopy = () => {
        navigator.clipboard.writeText(children as string);
        setIsCopied(true);
        setTimeout(() => {
            setIsCopied(false);
        }, 2000);
    };

    return (
        <Button
            variant="secondary"
            size="icon"
            className="text-muted-foreground bg-muted hover:bg-muted hover:text-primary absolute top-1.5 right-1 z-30 h-6 w-6 opacity-0 transition-[color,opacity] duration-200 group-hover:opacity-100 hover:opacity-100"
            onClick={handleCopy}
        >
            {isCopied ? (
                <Check className="h-4 w-4" />
            ) : (
                <Copy className="h-4 w-4" />
            )}
        </Button>
    );
}

const codeVariants = cva("rounded font-mono group", {
    variants: {
        variant: {
            default: "bg-muted relative block p-2 text-sm break-all",
            inline: "bg-muted px-1",
            numbered: "bg-muted relative block p-2 text-sm overflow-hidden",
        },
    },
    defaultVariants: {
        variant: "default",
    },
});

interface CodeProps
    extends React.ComponentPropsWithoutRef<"code">,
        VariantProps<typeof codeVariants> {
    children: React.ReactNode;
    startLine?: number;
    maxLines?: number;
    highlightLines?: number[];
    language?: string; // Added language prop
}

function InlineCode({
    children,
    className,
    ...props
}: Omit<CodeProps, "variant" | "startLine" | "highlightLines" | "language">) {
    return (
        <code
            className={cn(codeVariants({ variant: "inline", className }))}
            {...props}
        >
            {children}
        </code>
    );
}

function Code({
    children,
    className,
    variant,
    startLine = 1,
    maxLines,
    highlightLines = [],
    language = "typescript", // Default to typescript
    ...props
}: CodeProps) {
    const codeRef = React.useRef<HTMLElement>(null);

    React.useEffect(() => {
        if (codeRef.current && typeof children === "string") {
            Prism.highlightElement(codeRef.current);
        }
    }, [children, language]);

    if (variant === "inline") {
        return (
            <InlineCode className={className} {...props}>
                {children}
            </InlineCode>
        );
    }

    const showLineNumbers = variant === "numbered";
    const lines = typeof children === "string" ? children.split("\n") : [];

    const isLineHighlighted = (lineIndex: number): boolean => {
        return highlightLines.includes(startLine + lineIndex);
    };

    const containerStyle = maxLines
        ? { height: `${maxLines * 1.5}rem` }
        : undefined;

    return (
        <div
            className={cn(
                codeVariants({ variant, className }),
                "[&_[data-slot='scroll-area-thumb']]:bg-ring [&_[data-slot='scroll-area-thumb']]:hover:bg-muted-foreground relative text-nowrap",
                "[&_[data-slot='scroll-area-scrollbar'][data-orientation='vertical']]:w-1.5",
            )}
            {...props}
        >
            <CopyButton children={children} />
            {typeof children === "string" ? (
                <ScrollArea
                    style={containerStyle}
                    className={maxLines ? "h-full" : undefined}
                >
                    <div className="flex">
                        {showLineNumbers && (
                            <div className="text-muted-foreground border-muted-foreground/20 bg-muted sticky left-0 z-10 mr-2 border-r text-right select-none">
                                {lines.map((_, i) => (
                                    <div
                                        key={i}
                                        className={cn(
                                            "h-[1.5rem] pr-2.5 leading-[1.5rem]",
                                            isLineHighlighted(i) &&
                                                "text-foreground bg-yellow-500/20 font-medium",
                                        )}
                                    >
                                        {startLine + i}
                                    </div>
                                ))}
                            </div>
                        )}
                        <pre
                            className="flex-1"
                            style={{
                                padding: 0,
                                margin: 0,
                                backgroundColor: "transparent",
                            }}
                        >
                            <code
                                ref={codeRef}
                                className={`language-${language} !text-sm leading-[1.5rem]`}
                            >
                                {children}
                            </code>
                        </pre>
                    </div>
                    <ScrollBar
                        orientation="horizontal"
                        className="z-20 h-1.5 transition-colors"
                    />
                </ScrollArea>
            ) : (
                <code>{children}</code>
            )}
        </div>
    );
}

type RangeObject = { start: number; end: number };
type HighlightInput = number[] | string | RangeObject[];

/**
 * Generates line numbers to highlight in code blocks
 *
 * @param highlightInput - Input in various formats:
 *   - Array of numbers: [1, 2, 5]
 *   - String ranges: "1-3,5,7-9"
 *   - Object ranges: [{start: 1, end: 3}, {start: 5, end: 5}]
 * @returns Array of line numbers to highlight
 *
 * @example
 * // Returns [1, 2, 3, 5, 7, 8, 9]
 * highlight("1-3,5,7-9");
 *
 * @example
 * // Returns [9, 10, 11, 15]
 * highlight([{start: 9, end: 11}, {start: 15, end: 15}]);
 */
function highlight(highlightInput: HighlightInput): number[] {
    // If it's already an array of numbers, just return it
    if (
        Array.isArray(highlightInput) &&
        highlightInput.length > 0 &&
        typeof highlightInput[0] === "number"
    ) {
        return highlightInput as number[];
    }

    // If it's an array of range objects
    if (
        Array.isArray(highlightInput) &&
        highlightInput.length > 0 &&
        typeof highlightInput[0] === "object"
    ) {
        const ranges = highlightInput as RangeObject[];
        return ranges.flatMap((range) => {
            const result: number[] = [];
            for (let i = range.start; i <= range.end; i++) {
                result.push(i);
            }
            return result;
        });
    }

    // If it's a string format like "1-3,5,7-9"
    if (typeof highlightInput === "string") {
        return highlightInput
            .split(",")
            .flatMap((part) => {
                part = part.trim();
                if (part.includes("-")) {
                    const [start, end] = part.split("-").map(Number);
                    const result: number[] = [];
                    for (let i = start; i <= end; i++) {
                        result.push(i);
                    }
                    return result;
                }
                return [parseInt(part, 10)];
            })
            .filter((num) => !isNaN(num));
    }

    return [];
}

export { Code, highlight };
