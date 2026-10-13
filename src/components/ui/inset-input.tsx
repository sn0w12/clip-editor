import type { VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

import { Input, type InputProps } from "./input";
import {
    InputGroup,
    InputGroupAddon,
    type inputGroupAddonVariants,
} from "./input-group";

export function InsetInput({
    className,
    ...props
}: React.ComponentProps<"div">): React.ReactElement {
    return (
        <InputGroup
            className={cn(
                "border-secondary bg-secondary py-0.5 text-primary-foreground dark:bg-secondary",
                className
            )}
            data-slot="inset-input"
            {...props}
        />
    );
}

export function InsetInputAddition({
    className,
    ...props
}: React.ComponentProps<"div"> &
    VariantProps<typeof inputGroupAddonVariants>): React.ReactElement {
    return (
        <InputGroupAddon
            className={cn(
                "h-stretch text-primary-foreground data-[align=inline-end]:rounded-r-lg data-[align=inline-end]:pl-0.5 data-[align=inline-start]:rounded-l-lg data-[align=inline-start]:pr-0.5",
                className
            )}
            {...props}
        />
    );
}

export function InsetInputInput({
    className,
    ...props
}: InputProps): React.ReactElement {
    return (
        <div className="size-full px-0.5">
            <div className="size-full rounded-md bg-background text-foreground">
                <Input className={className} unstyled {...props} />
            </div>
        </div>
    );
}
