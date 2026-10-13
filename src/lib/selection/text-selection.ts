export function getSelectionText(): string {
    return window.getSelection()?.toString() ?? "";
}

export function clearSelection(): void {
    window.getSelection()?.removeAllRanges();
}

export function selectElementContents(element: Element): void {
    const selection = window.getSelection();
    if (!selection) return;

    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
}

export function selectionInSurface(element: Element): boolean {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        return false;
    }

    for (let index = 0; index < selection.rangeCount; index += 1) {
        if (selection.getRangeAt(index).intersectsNode(element)) return true;
    }
    return false;
}
