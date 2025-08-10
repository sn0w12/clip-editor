import React from "react";
import { Button } from "@/components/ui/button";
import {
    Popover,
    PopoverTrigger,
    PopoverContent,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Star, GitFork, Bug } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useGitHubRepoData } from "@/contexts/github-context";
import { APP_CONFIG } from "@/config";

const REPO_URL = `https://github.com/${APP_CONFIG.repo}`;

export const GitHubRepoLink: React.FC = () => {
    const { stats, openIssues } = useGitHubRepoData();
    const [open, setOpen] = React.useState(false);
    const closeTimeout = React.useRef<NodeJS.Timeout | null>(null);

    const handleMouseEnter = () => {
        if (closeTimeout.current) {
            clearTimeout(closeTimeout.current);
            closeTimeout.current = null;
        }
        setOpen(true);
    };

    const handleMouseLeave = () => {
        closeTimeout.current = setTimeout(() => setOpen(false), 150);
    };

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <a
                    href={REPO_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    onMouseEnter={handleMouseEnter}
                    onMouseLeave={handleMouseLeave}
                >
                    <Button variant="outline" size="sm" className="gap-2">
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="24"
                            height="24"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="lucide lucide-github h-4 w-4"
                            aria-hidden="true"
                        >
                            <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"></path>
                            <path d="M9 18c-4.51 2-5-2-7-2"></path>
                        </svg>
                        GitHub Repository
                    </Button>
                </a>
            </PopoverTrigger>
            <PopoverContent
                className="w-80"
                align="start"
                side="bottom"
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
            >
                <div className="mb-1 flex items-center gap-2">
                    <span className="font-semibold">Clip Editor</span>
                    {stats?.license && (
                        <Badge variant="secondary">
                            {stats.license.spdx_id}
                        </Badge>
                    )}
                </div>
                <span className="text-muted-foreground mb-2 block text-xs">
                    Last updated:{" "}
                    {stats
                        ? new Date(stats.updated_at).toLocaleDateString()
                        : "-"}
                </span>
                <Separator className="mb-2" />
                {stats ? (
                    <>
                        <div className="mb-2 text-sm">{stats.description}</div>
                        <div className="mb-2 flex gap-4">
                            <Badge variant="outline">
                                <Star className="mr-1 inline-block h-3 w-3" />
                                {stats.stargazers_count} Stars
                            </Badge>
                            <Badge variant="outline">
                                <GitFork className="mr-1 inline-block h-3 w-3" />
                                {stats.forks_count} Forks
                            </Badge>
                            <Badge variant="outline">
                                <Bug className="mr-1 inline-block h-3 w-3" />
                                {openIssues} Issues
                            </Badge>
                        </div>
                    </>
                ) : (
                    <div>Loading stats...</div>
                )}
            </PopoverContent>
        </Popover>
    );
};

export const GitHubIssuesLink: React.FC = () => {
    const { openIssues, closedIssues, issues } = useGitHubRepoData();
    const [open, setOpen] = React.useState(false);
    const closeTimeout = React.useRef<NodeJS.Timeout | null>(null);

    const handleMouseEnter = () => {
        if (closeTimeout.current) {
            clearTimeout(closeTimeout.current);
            closeTimeout.current = null;
        }
        setOpen(true);
    };

    const handleMouseLeave = () => {
        closeTimeout.current = setTimeout(() => setOpen(false), 150);
    };

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <a
                    href={`${REPO_URL}/issues`}
                    target="_blank"
                    rel="noopener noreferrer"
                    onMouseEnter={handleMouseEnter}
                    onMouseLeave={handleMouseLeave}
                >
                    <Button variant="outline" size="sm" className="gap-2">
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="h-4 w-4"
                        >
                            <circle cx="12" cy="12" r="10" />
                            <line x1="12" x2="12" y1="8" y2="12" />
                            <line x1="12" x2="12.01" y1="16" y2="16" />
                        </svg>
                        Report Issues
                    </Button>
                </a>
            </PopoverTrigger>
            <PopoverContent
                className="w-auto"
                align="start"
                side="bottom"
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
            >
                <span className="mb-1 block font-semibold">
                    Issues Overview
                </span>
                <Separator className="mb-2" />
                <div className="mb-2 flex gap-4">
                    <Badge variant="outline">Open: {openIssues ?? "-"}</Badge>
                    <Badge variant="outline">
                        Closed: {closedIssues ?? "-"}
                    </Badge>
                </div>
                <div className="text-muted-foreground mb-2 text-xs">
                    Recent Issues:
                </div>
                <div className="mb-2 max-h-48 overflow-y-auto pr-1">
                    {issues.length === 0 ? (
                        <div className="text-xs">No issues.</div>
                    ) : (
                        <ul className="ml-2 list-none">
                            {issues.map((issue) => (
                                <li
                                    key={issue.number}
                                    className="mb-3 flex flex-col gap-1 border-b pb-2 last:border-none last:pb-0"
                                >
                                    <div className="flex items-center gap-2">
                                        <a
                                            href={issue.user.html_url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                        >
                                            <img
                                                src={issue.user.avatar_url}
                                                alt={issue.user.login}
                                                className="inline-block h-5 w-5 rounded-full border"
                                            />
                                        </a>
                                        <a
                                            href={issue.html_url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-sm font-semibold underline"
                                        >
                                            #{issue.number} {issue.title}
                                        </a>
                                        <Badge
                                            variant={
                                                issue.state === "open"
                                                    ? "secondary"
                                                    : "outline"
                                            }
                                            className="ml-1"
                                        >
                                            {issue.state
                                                .charAt(0)
                                                .toUpperCase() +
                                                issue.state.slice(1)}
                                        </Badge>
                                    </div>
                                    <div className="ml-7 flex flex-wrap gap-1">
                                        {issue.labels.map((label) => (
                                            <span
                                                key={label.name}
                                                className="rounded px-2 py-0.5 text-xs"
                                                style={{
                                                    backgroundColor: `#${label.color}`,
                                                    color: "#fff",
                                                }}
                                            >
                                                {label.name}
                                            </span>
                                        ))}
                                    </div>
                                    <div className="text-muted-foreground ml-7 flex gap-2 text-xs">
                                        <span>
                                            Created:{" "}
                                            {new Date(
                                                issue.created_at,
                                            ).toLocaleDateString()}
                                        </span>
                                        {issue.closed_at && (
                                            <span>
                                                Closed:{" "}
                                                {new Date(
                                                    issue.closed_at,
                                                ).toLocaleDateString()}
                                            </span>
                                        )}
                                        <span>
                                            By:{" "}
                                            <a
                                                href={issue.user.html_url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="underline"
                                            >
                                                {issue.user.login}
                                            </a>
                                        </span>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </PopoverContent>
        </Popover>
    );
};

function parseMarkdown(md: string): React.ReactNode[] {
    const lines = md.split("\n");
    const result: React.ReactNode[] = [];
    let listItems: React.ReactNode[] = [];

    function parseLinks(text: string): React.ReactNode[] {
        // [text](url)
        const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
        // #123 (issue/pr reference)
        const issueRegex = /#(\d+)/g;
        const parts: React.ReactNode[] = [];
        let lastIndex = 0;
        let match: RegExpExecArray | null;

        while ((match = linkRegex.exec(text)) !== null) {
            if (match.index > lastIndex) {
                parts.push(text.slice(lastIndex, match.index));
            }
            parts.push(
                <a
                    key={match[2] + match.index}
                    href={match[2]}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                >
                    {match[1]}
                </a>,
            );
            lastIndex = linkRegex.lastIndex;
        }
        const remaining = text.slice(lastIndex);

        let issueLastIndex = 0;
        while ((match = issueRegex.exec(remaining)) !== null) {
            if (match.index > issueLastIndex) {
                parts.push(remaining.slice(issueLastIndex, match.index));
            }
            parts.push(
                <a
                    key={`issue-${match[1]}-${match.index}`}
                    href={`${REPO_URL}/issues/${match[1]}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                >
                    #{match[1]}
                </a>,
            );
            issueLastIndex = issueRegex.lastIndex;
        }
        if (issueLastIndex < remaining.length) {
            parts.push(remaining.slice(issueLastIndex));
        }
        return parts;
    }

    lines.forEach((line, idx) => {
        if (line.startsWith("## ")) {
            // End previous list
            if (listItems.length) {
                result.push(
                    <ul
                        key={`ul-${idx}`}
                        className="mb-2 ml-4 list-disc text-xs"
                    >
                        {listItems}
                    </ul>,
                );
                listItems = [];
            }
            result.push(
                <div
                    key={`h2-${idx}`}
                    className="mt-2 mb-1 text-xs font-semibold"
                >
                    {line.replace(/^## /, "")}
                </div>,
            );
        } else if (line.startsWith("- ")) {
            listItems.push(
                <li key={`li-${idx}`} className="text-xs">
                    {parseLinks(line.replace(/^- /, ""))}
                </li>,
            );
        } else if (line.trim() === "") {
            // End previous list
            if (listItems.length) {
                result.push(
                    <ul
                        key={`ul-${idx}`}
                        className="mb-2 ml-4 list-disc text-xs"
                    >
                        {listItems}
                    </ul>,
                );
                listItems = [];
            }
        } else {
            // Paragraph or link
            result.push(
                <div key={`p-${idx}`} className="mb-2 text-xs">
                    {parseLinks(line)}
                </div>,
            );
        }
    });
    // End last list
    if (listItems.length) {
        result.push(
            <ul key={`ul-last`} className="mb-2 ml-4 list-disc text-xs">
                {listItems}
            </ul>,
        );
    }
    return result;
}

export const GitHubReleasesLink: React.FC = () => {
    const { release } = useGitHubRepoData();
    const [open, setOpen] = React.useState(false);
    const [tab, setTab] = React.useState("notes");
    const closeTimeout = React.useRef<NodeJS.Timeout | null>(null);

    const handleMouseEnter = () => {
        if (closeTimeout.current) {
            clearTimeout(closeTimeout.current);
            closeTimeout.current = null;
        }
        setOpen(true);
    };

    const handleMouseLeave = () => {
        closeTimeout.current = setTimeout(() => setOpen(false), 150);
    };

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <a
                    href={`${REPO_URL}/releases`}
                    target="_blank"
                    rel="noopener noreferrer"
                    onMouseEnter={handleMouseEnter}
                    onMouseLeave={handleMouseLeave}
                >
                    <Button variant="outline" size="sm" className="gap-2">
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="h-4 w-4"
                        >
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="7 10 12 15 17 10" />
                            <line x1="12" x2="12" y1="15" y2="3" />
                        </svg>
                        Latest Releases
                    </Button>
                </a>
            </PopoverTrigger>
            <PopoverContent
                className="w-80"
                align="start"
                side="bottom"
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
            >
                {release ? (
                    <>
                        <div className="flex items-start justify-between">
                            <div>
                                <span className="block font-semibold">
                                    {release.name || release.tag_name}
                                </span>
                                <span className="text-muted-foreground mb-1 block text-xs">
                                    {new Date(
                                        release.published_at,
                                    ).toLocaleDateString()}
                                </span>
                            </div>
                        </div>
                        <Separator className="mb-2" />
                        <Tabs value={tab} onValueChange={setTab}>
                            <TabsList defaultValue={"notes"} size="small">
                                <TabsTrigger value="notes" size="small">
                                    Release Notes
                                </TabsTrigger>
                                <TabsTrigger value="assets" size="small">
                                    Assets
                                </TabsTrigger>
                            </TabsList>
                            <TabsContent value="notes">
                                <div className="mb-2 max-h-48 overflow-y-auto pr-2">
                                    {parseMarkdown(release.body || "")}
                                </div>
                            </TabsContent>
                            <TabsContent value="assets">
                                <div className="mb-2">
                                    <ul className="ml-4 list-disc">
                                        {release.assets.map((asset) => (
                                            <li key={asset.name}>
                                                <a
                                                    href={
                                                        asset.browser_download_url
                                                    }
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="text-xs underline"
                                                >
                                                    {asset.name}
                                                </a>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            </TabsContent>
                        </Tabs>
                    </>
                ) : (
                    <div>Loading release info...</div>
                )}
            </PopoverContent>
        </Popover>
    );
};
