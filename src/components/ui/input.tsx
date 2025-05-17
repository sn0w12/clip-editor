import * as React from "react";

import { cn } from "@/utils/tailwind";
import { Button } from "./button";
import { ChevronDown, ChevronUp } from "lucide-react";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
    return (
        <input
            type={type}
            data-slot="input"
            className={cn(
                "file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-input flex h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
                "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
                "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
                className,
            )}
            {...props}
        />
    );
}

interface NumberInputProps extends React.ComponentProps<"input"> {
    onIncrement?: () => void;
    onDecrement?: () => void;
}

function NumberInput({
    className,
    onIncrement,
    onDecrement,
    ...props
}: NumberInputProps) {
    return (
        <div className="relative">
            <Input
                {...props}
                className={`pr-8 ${className}`} // Added padding for buttons
            />
            <div className="absolute top-0 right-0 flex h-full flex-col">
                <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground hover:text-foreground h-1/2 px-2 py-0"
                    onClick={onIncrement}
                >
                    <ChevronUp className="h-3 w-3" />
                </Button>
                <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground hover:text-foreground h-1/2 px-2 py-0"
                    onClick={onDecrement}
                >
                    <ChevronDown className="h-3 w-3" />
                </Button>
            </div>
        </div>
    );
}

export { Input, NumberInput };
