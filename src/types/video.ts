export interface VideoFile {
    name: string;
    game: string;
    path: string;
    size: number;
    lastModified: string;
    gameImages?: GameImage;
}

export interface VideoGroup {
    id: string;
    name: string;
    color?: string;
}

export interface VideoGroupAssignment {
    videoPath: string;
    groupId: string;
}
