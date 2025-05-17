"use client";

import * as React from "react";
import { X, ChevronsUpDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from "@/components/ui/command";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/utils/tailwind";
import { Button } from "@/components/ui/button";
import { Check } from "lucide-react";

export type Option = {
    value: string;
    label: string;
    icon?: React.ReactNode;
};

interface MultiSelectProps {
    options: Option[];
    selected: string[];
    onChange: (selected: string[]) => void;
    className?: string;
    placeholder?: string;
    emptyText?: string;
}

export function MultiSelect({
    options,
    selected,
    onChange,
    className,
    placeholder = "Select options",
    emptyText = "No options found.",
}: MultiSelectProps) {
    const [open, setOpen] = React.useState(false);

    const handleUnselect = (value: string) => {
        onChange(selected.filter((item) => item !== value));
    };

    const handleSelect = (value: string) => {
        if (selected.includes(value)) {
            onChange(selected.filter((item) => item !== value));
        } else {
            onChange([...selected, value]);
        }
    };

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={open}
                    className={cn(
                        "group h-auto min-h-10 w-full justify-between px-2",
                        className,
                    )}
                    onClick={() => setOpen(!open)}
                >
                    <div className="flex flex-wrap gap-1">
                        {selected.length > 0 ? (
                            selected.length <= 2 ? (
                                selected.map((value) => {
                                    const option = options.find(
                                        (opt) => opt.value === value,
                                    );
                                    return (
                                        <Badge
                                            variant="secondary"
                                            key={value}
                                            className="hover:bg-background group-hover:border-background transition-snappy h-7 transition-colors"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                handleUnselect(value);
                                            }}
                                        >
                                            {option?.icon && (
                                                <span className="mr-1">
                                                    {option.icon}
                                                </span>
                                            )}
                                            {option?.label}
                                            <X className="ml-1 h-3 w-3" />
                                        </Badge>
                                    );
                                })
                            ) : (
                                <span>{selected.length} selected</span>
                            )
                        ) : (
                            <span className="text-muted-foreground">
                                {placeholder}
                            </span>
                        )}
                    </div>
                    <ChevronsUpDown className="h-4 w-4" />
                </Button>
            </PopoverTrigger>
            <PopoverContent className="w-full p-0" align="center">
                <Command>
                    <CommandInput placeholder={`Search...`} />
                    <CommandList>
                        <CommandEmpty>{emptyText}</CommandEmpty>
                        <CommandGroup>
                            {options.map((option) => {
                                const isSelected = selected.includes(
                                    option.value,
                                );
                                return (
                                    <CommandItem
                                        key={option.value}
                                        onSelect={() =>
                                            handleSelect(option.value)
                                        }
                                        className="flex items-center justify-between"
                                    >
                                        <div className="flex items-center">
                                            {option.icon && (
                                                <span className="mr-2">
                                                    {option.icon}
                                                </span>
                                            )}
                                            <span>{option.label}</span>
                                        </div>
                                        {isSelected && (
                                            <Check className="h-4 w-4" />
                                        )}
                                    </CommandItem>
                                );
                            })}
                        </CommandGroup>
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
}
