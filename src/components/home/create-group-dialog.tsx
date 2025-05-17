import * as React from "react";
import { useState } from "react";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ColorPicker } from "@/components/ui/color-picker";

interface CreateGroupDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCreateGroup: (name: string, color?: string) => void;
}

export function CreateGroupDialog({
    open,
    onOpenChange,
    onCreateGroup,
}: CreateGroupDialogProps) {
    const [groupName, setGroupName] = useState("");
    const [groupColor, setGroupColor] = useState("#3B82F6"); // Default blue color
    const [error, setError] = useState<string | null>(null);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();

        if (!groupName.trim()) {
            setError("Group name is required");
            return;
        }

        onCreateGroup(groupName.trim(), groupColor);
        setGroupName("");
        setGroupColor("#3B82F6");
        setError(null);
        onOpenChange(false);
    };

    const handleClose = () => {
        setGroupName("");
        setGroupColor("#3B82F6");
        setError(null);
        onOpenChange(false);
    };

    return (
        <Dialog open={open} onOpenChange={handleClose}>
            <DialogContent className="sm:max-w-[425px]">
                <form onSubmit={handleSubmit}>
                    <DialogHeader>
                        <DialogTitle>Create New Group</DialogTitle>
                        <DialogDescription>
                            Enter a name for your new video group.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-4 py-4">
                        <div className="grid grid-cols-4 items-center gap-4">
                            <Label htmlFor="group-name" className="col-span-4">
                                Group Name
                            </Label>
                            <Input
                                id="group-name"
                                value={groupName}
                                onChange={(e) => {
                                    setGroupName(e.target.value);
                                    if (error) setError(null);
                                }}
                                placeholder="Enter group name"
                                className="col-span-4"
                                autoFocus
                            />
                            {error && (
                                <p className="text-destructive col-span-4 text-sm">
                                    {error}
                                </p>
                            )}
                        </div>
                        <div className="grid grid-cols-4 items-center gap-4">
                            <Label htmlFor="group-color" className="col-span-3">
                                Group Color
                            </Label>
                            <ColorPicker
                                id="group-color"
                                value={groupColor}
                                onChange={setGroupColor}
                                className="h-10 w-10"
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={handleClose}
                        >
                            Cancel
                        </Button>
                        <Button type="submit">Create Group</Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
