import React, { createContext, useContext, useRef } from "react";
// @ts-expect-error - Ignoring ESM/CommonJS module warning
import { Box } from "@air/react-drag-to-select";

type SelectionState = {
    enabled: boolean;
    isSelecting: boolean;
    onSelectionChange?: (box: Box | null) => void;
    shouldStartSelecting?: (target: EventTarget) => boolean;
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
            callback: ((box: Box | null) => void) | undefined,
        ) => context.setState({ onSelectionChange: callback }),
        setShouldStartSelecting: (
            callback: ((target: EventTarget) => boolean) | undefined,
        ) => context.setState({ shouldStartSelecting: callback }),
        getState: context.getState,
    };
}
