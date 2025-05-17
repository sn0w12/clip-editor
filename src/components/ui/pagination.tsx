import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { NumberInput } from "./input";

interface PaginationProps {
    currentPage: number;
    totalPages: number;
    onPageChange: (page: number) => void;
    itemsPerPage: number;
    totalItems: number;
}

function Ellipsis({
    currentPage,
    totalPages,
    onPageChange,
}: {
    currentPage: number;
    totalPages: number;
    onPageChange: (page: number) => void;
}) {
    const [inputPage, setInputPage] = useState(currentPage);
    const [open, setOpen] = useState(false);

    useEffect(() => {
        setInputPage(currentPage);
    }, [currentPage]);
    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setInputPage(Number(e.target.value));
    };

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger>
                <span className="mx-2 cursor-pointer">...</span>
            </PopoverTrigger>
            <PopoverContent className="flex w-32 flex-col gap-2">
                <NumberInput
                    type="number"
                    value={inputPage}
                    onChange={handleInputChange}
                    onIncrement={() =>
                        setInputPage((prev) => Math.min(prev + 1, totalPages))
                    }
                    onDecrement={() =>
                        setInputPage((prev) => Math.max(prev - 1, 1))
                    }
                    min={1}
                    max={totalPages}
                    placeholder={`Enter a page (1-${totalPages})`}
                />
                <Button
                    className="h-8 w-full"
                    onClick={() => {
                        if (inputPage >= 1 && inputPage <= totalPages) {
                            onPageChange(inputPage);
                            setOpen(false);
                        }
                    }}
                >
                    Go
                </Button>
            </PopoverContent>
        </Popover>
    );
}

function PageButton({
    currentPage,
    page,
    onPageChange,
}: {
    currentPage: number;
    page: number;
    onPageChange: (page: number) => void;
}) {
    return (
        <Button
            variant={currentPage === page ? "default" : "outline"}
            size="sm"
            className="w-8"
            onClick={() => onPageChange(page as number)}
        >
            {page}
        </Button>
    );
}

export function Pagination({
    currentPage,
    totalPages,
    onPageChange,
    itemsPerPage,
    totalItems,
}: PaginationProps) {
    const currentStart = (currentPage - 1) * itemsPerPage + 1;
    const currentEnd = Math.min(currentPage * itemsPerPage, totalItems);

    return (
        <div className="mt-4 flex items-center justify-between">
            <div className="text-muted-foreground text-sm">
                Showing {currentStart}-{currentEnd} of {totalItems} items
            </div>
            <div className="flex items-center gap-1">
                <Button
                    variant="outline"
                    size="sm"
                    className="w-24"
                    onClick={() => onPageChange(currentPage - 1)}
                    disabled={currentPage === 1}
                >
                    <ChevronLeft className="mr-1 h-4 w-4" />
                    Prev
                </Button>

                <div className="mx-2 flex items-center gap-1">
                    {currentPage > 2 && (
                        <>
                            <PageButton
                                currentPage={currentPage}
                                page={1}
                                onPageChange={onPageChange}
                            />
                            <Ellipsis
                                currentPage={currentPage}
                                totalPages={totalPages}
                                onPageChange={onPageChange}
                            />
                        </>
                    )}

                    {[...Array(totalPages)].map((_, i) => {
                        if (
                            i + 1 >= currentPage - 1 &&
                            i + 1 <= currentPage + 1
                        ) {
                            return (
                                <PageButton
                                    key={i}
                                    currentPage={currentPage}
                                    page={i + 1}
                                    onPageChange={onPageChange}
                                />
                            );
                        }
                        return null;
                    })}

                    {currentPage < totalPages - 1 && (
                        <>
                            <Ellipsis
                                currentPage={currentPage}
                                totalPages={totalPages}
                                onPageChange={onPageChange}
                            />
                            <PageButton
                                currentPage={currentPage}
                                page={totalPages}
                                onPageChange={onPageChange}
                            />
                        </>
                    )}
                </div>

                <Button
                    variant="outline"
                    size="sm"
                    className="w-24"
                    onClick={() => onPageChange(currentPage + 1)}
                    disabled={currentPage >= totalPages}
                >
                    Next
                    <ChevronRight className="ml-1 h-4 w-4" />
                </Button>
            </div>
        </div>
    );
}
