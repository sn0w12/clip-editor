import React, { createContext, useContext, useEffect, useState } from "react";
import { APP_CONFIG } from "@/config";

const REPO = APP_CONFIG.repo;

interface RepoStats {
    stargazers_count: number;
    forks_count: number;
    open_issues_count: number;
    description: string;
    license?: { name: string; spdx_id: string };
    updated_at: string;
    html_url: string;
}

interface IssueInfo {
    title: string;
    html_url: string;
    state: string;
    number: number;
    user: {
        login: string;
        avatar_url: string;
        html_url: string;
    };
    labels: Array<{ name: string; color: string }>;
    created_at: string;
    closed_at?: string;
    body?: string;
    pull_request?: unknown;
}

interface ReleaseInfo {
    name: string;
    tag_name: string;
    published_at: string;
    html_url: string;
    body: string;
    assets: Array<{ name: string; browser_download_url: string }>;
}

interface GitHubRepoData {
    stats: RepoStats | null;
    openIssues: number | null;
    closedIssues: number | null;
    issues: IssueInfo[];
    release: ReleaseInfo | null;
    loading: boolean;
    error: string | null;
}

const GitHubDataContext = createContext<GitHubRepoData | undefined>(undefined);

export function useGitHubRepoData(): GitHubRepoData {
    const ctx = useContext(GitHubDataContext);
    if (!ctx)
        throw new Error(
            "useGitHubRepoData must be used within a GitHubDataProvider",
        );
    return ctx;
}

export function GitHubDataProvider({
    children,
}: {
    children: React.ReactNode;
}) {
    const [data, setData] = useState<GitHubRepoData>({
        stats: null,
        openIssues: null,
        closedIssues: null,
        issues: [],
        release: null,
        loading: true,
        error: null,
    });

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setData((d) => ({ ...d, loading: true, error: null }));
            try {
                const [statsRes, openData, closedData, recentData, releaseRes] =
                    await Promise.all([
                        fetch(`https://api.github.com/repos/${REPO}`),
                        fetch(
                            `https://api.github.com/search/issues?q=repo:${REPO}+type:issue+state:open`,
                        ),
                        fetch(
                            `https://api.github.com/search/issues?q=repo:${REPO}+type:issue+state:closed`,
                        ),
                        fetch(
                            `https://api.github.com/repos/${REPO}/issues?state=all&per_page=10&sort=created&direction=desc`,
                        ),
                        fetch(
                            `https://api.github.com/repos/${REPO}/releases/latest`,
                        ),
                    ]);
                const statsData = await statsRes.json();
                const openDataJson = await openData.json();
                const closedDataJson = await closedData.json();
                const recentDataJson = await recentData.json();
                const releaseData = await releaseRes.json();

                if (cancelled) return;

                setData({
                    stats: statsData,
                    openIssues:
                        typeof openDataJson.total_count === "number"
                            ? openDataJson.total_count
                            : null,
                    closedIssues:
                        typeof closedDataJson.total_count === "number"
                            ? closedDataJson.total_count
                            : null,
                    issues: Array.isArray(recentDataJson)
                        ? recentDataJson
                              .filter((issue: IssueInfo) => !issue.pull_request)
                              .slice(0, 5)
                              .map((issue: IssueInfo) => ({
                                  title: issue.title,
                                  html_url: issue.html_url,
                                  state: issue.state,
                                  number: issue.number,
                                  user: {
                                      login: issue.user.login,
                                      avatar_url: issue.user.avatar_url,
                                      html_url: issue.user.html_url,
                                  },
                                  labels: Array.isArray(issue.labels)
                                      ? issue.labels.map(
                                            (l: {
                                                name: string;
                                                color: string;
                                            }) => ({
                                                name: l.name,
                                                color: l.color,
                                            }),
                                        )
                                      : [],
                                  created_at: issue.created_at,
                                  closed_at: issue.closed_at,
                                  body: issue.body,
                              }))
                        : [],
                    release: {
                        ...releaseData,
                        assets: Array.isArray(releaseData.assets)
                            ? releaseData.assets.map(
                                  (a: {
                                      name: string;
                                      browser_download_url: string;
                                  }) => ({
                                      name: a.name,
                                      browser_download_url:
                                          a.browser_download_url,
                                  }),
                              )
                            : [],
                    },
                    loading: false,
                    error: null,
                });
            } catch {
                setData((d) => ({
                    ...d,
                    loading: false,
                    error: "Failed to fetch GitHub data",
                }));
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    return (
        <GitHubDataContext.Provider value={data}>
            {children}
        </GitHubDataContext.Provider>
    );
}
