// Vendored from agmmnn/tauri-controls branch new-system at be10359
// (PR #41, MIT, author agmmnn). Local copy so the app tracks the fix
// without depending on or republishing an unmerged branch.
export {
    detectPlatform,
    getControlsOrder,
    getControlsJustify,
} from "./platform";
export { createWindowControls } from "./window";
export type { WindowControlsApi } from "./window";
export { icons } from "./icons-data";
export type { IconData } from "./icons-data";
export { styles } from "./styles";
export type {
    ControlsOrder,
    Platform,
    WindowControlsProps,
    WindowTitlebarProps,
} from "./types";
export { WindowControls } from "./WindowControls";
export { WindowTitlebar } from "./WindowTitlebar";
