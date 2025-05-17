import React, { useEffect, useState } from "react";
import PuffLoader from "react-spinners/PuffLoader";

interface SpinnerProps {
    size?: number;
}

const Spinner: React.FC<SpinnerProps> = ({ size = 60 }) => {
    const [spinnerColor, setSpinnerColor] = useState<string>("");

    useEffect(() => {
        const rootStyles = getComputedStyle(document.documentElement);
        const foregroundColor = rootStyles
            .getPropertyValue("--foreground")
            .trim();

        if (foregroundColor) {
            setSpinnerColor(foregroundColor);
        } else {
            setSpinnerColor("#000000"); // Fallback to black if the variable is not defined
        }
    }, []);

    return <PuffLoader color={spinnerColor} size={size} />;
};

export default Spinner;
