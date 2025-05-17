import { ThemeMode } from "@/types/theme-mode";
import { platform } from "../platform";

const THEME_KEY = "theme";

export interface ThemePreferences {
    system: ThemeMode;
    local: ThemeMode | null;
}

export async function getCurrentTheme(): Promise<ThemePreferences> {
    let currentTheme: ThemeMode = "system";
    const localTheme = localStorage.getItem(THEME_KEY) as ThemeMode | null;

    // Use Electron's API if available, otherwise infer from browser
    if (!platform.isWeb() && window.themeMode) {
        currentTheme = await window.themeMode.current();
    } else {
        // For web, check if media query for dark mode matches
        const isDarkMode = window.matchMedia(
            "(prefers-color-scheme: dark)",
        ).matches;
        currentTheme = isDarkMode ? "dark" : "light";
    }

    return {
        system: currentTheme,
        local: localTheme,
    };
}

export async function setTheme(newTheme: ThemeMode): Promise<void> {
    let isDarkMode = false;

    // Different behavior based on platform
    if (!platform.isWeb() && window.themeMode) {
        // Electron app
        switch (newTheme) {
            case "dark":
                await window.themeMode.dark();
                isDarkMode = true;
                break;
            case "light":
                await window.themeMode.light();
                isDarkMode = false;
                break;
            case "system": {
                isDarkMode = await window.themeMode.system();
                break;
            }
        }
    } else {
        // Web app
        switch (newTheme) {
            case "dark":
                isDarkMode = true;
                break;
            case "light":
                isDarkMode = false;
                break;
            case "system": {
                isDarkMode = window.matchMedia(
                    "(prefers-color-scheme: dark)",
                ).matches;
                break;
            }
        }
    }

    updateDocumentTheme(isDarkMode);
    localStorage.setItem(THEME_KEY, newTheme);
}

export async function toggleTheme(): Promise<void> {
    const { local } = await getCurrentTheme();
    const isDark =
        local === "dark" ||
        (local === "system" &&
            window.matchMedia("(prefers-color-scheme: dark)").matches);

    const newTheme = isDark ? "light" : "dark";

    if (!platform.isWeb() && window.themeMode) {
        await window.themeMode.toggle();
    }

    updateDocumentTheme(!isDark);
    localStorage.setItem(THEME_KEY, newTheme);
}

export async function syncThemeWithLocal(): Promise<void> {
    const { local } = await getCurrentTheme();
    if (!local) {
        await setTheme("system");
        return;
    }

    await setTheme(local);
}

export function addSystemThemeListener(): void {
    if (platform.isWeb()) {
        const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
        const handleChange = async (e: MediaQueryListEvent) => {
            const { local } = await getCurrentTheme();
            if (local === "system") {
                updateDocumentTheme(e.matches);
            }
        };

        // Different APIs for different browsers
        if (mediaQuery.addEventListener) {
            mediaQuery.addEventListener("change", handleChange);
        } else if (mediaQuery.addListener) {
            mediaQuery.addListener(handleChange);
        }
    }
}

function updateDocumentTheme(isDarkMode: boolean): void {
    if (!isDarkMode) {
        document.documentElement.classList.remove("dark");
    } else {
        document.documentElement.classList.add("dark");
    }
}
