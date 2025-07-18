import { SelectionBox } from "@/hooks/use-drag-selection";
import React, { createContext, useContext, useRef } from "react";

type SelectionState = {
    enabled: boolean;
    isSelecting: boolean;
    onSelectionChange?: (box: SelectionBox | null) => void;
    shouldStartSelecting?: (target: EventTarget) => boolean;
    onSelectionStart?: () => void;
    onSelectionEnd?: () => void;
};

type SelectionContextType = {
    getState: () => SelectionState;
    setState: (state: Partial<SelectionState>) => void;
};

const SelectionContext = createContext<SelectionContextType | null>(null);

export function SelectionProvider({ children }: { children: React.ReactNode }) {
    const stateRef = useRef<SelectionState>({
        enabled: false,
        isSelecting: false,
    });

    const value = React.useMemo(
        () => ({
            getState: () => stateRef.current,
            setState: (newState: Partial<SelectionState>) => {
                stateRef.current = { ...stateRef.current, ...newState };
            },
        }),
        [],
    );

    return (
        <SelectionContext.Provider value={value}>
            {children}
        </SelectionContext.Provider>
    );
}

export function useSelection() {
    const context = useContext(SelectionContext);
    if (!context) {
        throw new Error("useSelection must be used within a SelectionProvider");
    }
    return {
        enableSelection: (enabled: boolean) => context.setState({ enabled }),
        setIsSelecting: (isSelecting: boolean) =>
            context.setState({ isSelecting }),
        setOnSelectionChange: (
            callback: ((box: SelectionBox | null) => void) | undefined,
        ) => context.setState({ onSelectionChange: callback }),
        setShouldStartSelecting: (
            callback: ((target: EventTarget) => boolean) | undefined,
        ) => context.setState({ shouldStartSelecting: callback }),
        setOnSelectionStart: (callback: (() => void) | undefined) => {
            const wrappedCallback = callback
                ? () => {
                      context.setState({ isSelecting: true });
                      callback();
                  }
                : undefined;
            context.setState({ onSelectionStart: wrappedCallback });
        },
        setOnSelectionEnd: (callback: (() => void) | undefined) => {
            const wrappedCallback = callback
                ? () => {
                      context.setState({ isSelecting: false });
                      callback();
                  }
                : undefined;
            context.setState({ onSelectionEnd: wrappedCallback });
        },
        getState: context.getState,
        isSelecting: () => context.getState().isSelecting,
    };
}
