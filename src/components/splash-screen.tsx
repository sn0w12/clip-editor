import React from "react";
import Spinner from "./ui/spinners/puff-loader";

interface SplashScreenProps {
    appName?: string;
}

export const SplashScreen: React.FC<SplashScreenProps> = ({
    appName = "Electron App",
}) => {
    return (
        <div className="bg-background flex h-screen w-screen flex-col items-center justify-center">
            <div className="flex flex-col items-center gap-4">
                <div className="h-24 w-24">
                    <Spinner />
                </div>
                <h1 className="text-foreground text-xl font-semibold">
                    {appName}
                </h1>
            </div>
        </div>
    );
};
