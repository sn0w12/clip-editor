import "@/App";

const savedTheme = localStorage.getItem("theme");
if (
    savedTheme === "dark" ||
    (savedTheme === "system" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches)
) {
    document.documentElement.classList.add("dark");
} else {
    document.documentElement.classList.remove("dark");
}

const applyAccentColors = () => {
    try {
        const storedSettings = localStorage.getItem("settings");
        if (storedSettings) {
            const settings = JSON.parse(storedSettings);

            // Set positive accent color if available
            if (settings.positiveAccentColor) {
                document.documentElement.style.setProperty(
                    "--accent-positive",
                    settings.positiveAccentColor,
                );
            }

            if (settings.warningAccentColor) {
                document.documentElement.style.setProperty(
                    "--accent-waning",
                    settings.warningAccentColor,
                );
            }

            // Set negative accent color if available
            if (settings.negativeAccentColor) {
                document.documentElement.style.setProperty(
                    "--accent-negative",
                    settings.negativeAccentColor,
                );
            }
        }
    } catch (error) {
        console.error("Error applying accent colors:", error);
    }
};

applyAccentColors();
if (window.appConfig) {
    const titleElement = document.getElementById("app-title");
    const nameElement = document.getElementById("app-name");
    if (titleElement) {
        titleElement.textContent = window.appConfig.name;
    }
    if (nameElement) {
        nameElement.textContent = window.appConfig.name;
    }
}
window.addEventListener("settingsChange", (event) => {
    const customEvent = event as CustomEvent;
    if (
        customEvent.detail?.key === "positiveAccentColor" ||
        customEvent.detail?.key === "negativeAccentColor" ||
        customEvent.detail?.key === "warningAccentColor"
    ) {
        applyAccentColors();
    }
});
