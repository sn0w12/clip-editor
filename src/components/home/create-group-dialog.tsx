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

interface CreateGroupDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCreateGroup: (name: string) => void;
}

export function CreateGroupDialog({
    open,
    onOpenChange,
    onCreateGroup,
}: CreateGroupDialogProps) {
    const [groupName, setGroupName] = useState("");
    const [error, setError] = useState<string | null>(null);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();

        if (!groupName.trim()) {
            setError("Group name is required");
            return;
        }

        onCreateGroup(groupName.trim());
        setGroupName("");
        setError(null);
        onOpenChange(false);
    };

    const handleClose = () => {
        setGroupName("");
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
