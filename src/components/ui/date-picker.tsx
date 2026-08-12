"use client";

import { CalendarIcon } from "lucide-react";
import type * as React from "react";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const dateFormatter = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
});

export interface DatePickerProps {
    value?: Date;
    onValueChange?: (date: Date | undefined) => void;
    placeholder?: string;
    className?: string;
    disabled?: boolean;
}

/**
 * Date Picker: Calendar + Popover + Button composition (coss docs pattern).
 */
export function DatePicker({
    value,
    onValueChange,
    placeholder = "Pick a date",
    className,
    disabled,
}: DatePickerProps): React.ReactElement {
    return (
        <Popover>
            <PopoverTrigger
                render={
                    <Button
                        variant="outline"
                        disabled={disabled}
                        className={cn(
                            "w-full justify-start gap-2 font-normal not-disabled:justify-between",
                            !value && "text-muted-foreground",
                            className,
                        )}
                    >
                        <span className="flex items-center gap-2">
                            <CalendarIcon />
                            {value ? dateFormatter.format(value) : placeholder}
                        </span>
                    </Button>
                }
            />
            <PopoverContent align="start" className="w-auto p-0">
                <Calendar mode="single" selected={value} onSelect={onValueChange} autoFocus />
            </PopoverContent>
        </Popover>
    );
}
