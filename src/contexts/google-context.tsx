import React, { createContext, useContext, useEffect, useState } from "react";
import { Credentials } from "google-auth-library";

interface GoogleProfile {
    name: string;
    email: string;
    photo: string;
}

interface GoogleContextType {
    tokens: Credentials | null;
    profile: GoogleProfile | null;
    videos: GoogleDriveFile[];
    setTokens: (tokens: Credentials | null) => void;
    refreshProfile: () => Promise<void>;
    signOut: () => Promise<void>;
}

const GoogleContext = createContext<GoogleContextType | undefined>(undefined);

export const GoogleProvider: React.FC<{ children: React.ReactNode }> = ({
    children,
}) => {
    const [tokens, setTokens] = useState<Credentials | null>(null);
    const [profile, setProfile] = useState<GoogleProfile | null>(null);
    const [videos, setVideos] = useState<GoogleDriveFile[]>([]);

    useEffect(() => {
        window.googleDrive.getSavedTokens().then((saved) => {
            if (saved) setTokens(saved);
        });
    }, []);

    useEffect(() => {
        if (tokens) {
            refreshProfile();
            getVideos();
        } else {
            setProfile(null);
        }
    }, [tokens]);

    const refreshProfile = async () => {
        if (!tokens) {
            setProfile(null);
            return;
        }
        try {
            const person = await window.googleDrive.getProfile(tokens);
            if (person) {
                setProfile({
                    name: person.name,
                    email: person.email,
                    photo: person.photo,
                });
            } else {
                setProfile(null);
            }
        } catch {
            setProfile(null);
        }
    };

    const getVideos = async () => {
        if (!tokens) return;
        try {
            const videoList =
                await window.googleDrive.getVideoFolderFiles(tokens);
            setVideos(videoList.files);
        } catch {
            setVideos([]);
        }
    };

    const signOut = async () => {
        await window.googleDrive.signOut();
        setTokens(null);
        setProfile(null);
    };

    return (
        <GoogleContext.Provider
            value={{
                tokens,
                profile,
                videos,
                setTokens,
                refreshProfile,
                signOut,
            }}
        >
            {children}
        </GoogleContext.Provider>
    );
};

export function useGoogle() {
    const ctx = useContext(GoogleContext);
    if (!ctx) throw new Error("useGoogle must be used within a GoogleProvider");
    return ctx;
}
