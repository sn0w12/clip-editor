import { Markdown, type MarkdownComponents } from "@tanstack/markdown/react";
import { Children, isValidElement, useMemo } from "react";

import { ExternalLink } from "@/components/external-link";
import { MarkdownAlert } from "@/components/markdown/alert";
import { MarkdownDetails } from "@/components/markdown/details";
import { Checkbox } from "@/components/ui/checkbox";
import { Frame, FramePanel } from "@/components/ui/frame";
import { Kbd } from "@/components/ui/kbd";
import { Separator } from "@/components/ui/separator";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { ALERT_TAG, githubMarkdownExtension } from "@/lib/markdown/github";
import type { GithubCoords } from "@/lib/markdown/github";
import {
    DETAILS_TAG,
    normalizeHtmlBlocks,
    safeHtmlExtension,
} from "@/lib/markdown/html";
import { cn } from "@/lib/utils";

/**
 * Hosts allowed to render as an <img>. The CSP blocks remote images anyway,
 * so an untrusted host becomes a link rather than a broken frame.
 */
const TRUSTED_IMAGE_HOSTS =
    /^(https:\/\/)?(github\.com|githubusercontent\.com|githubassets\.com)\//i;

function linkHref(href: string | undefined): string | undefined {
    const hasProtocol = /^[a-z][a-z0-9+.-]*:/i.test(href || "");
    const allowed = !hasProtocol || /^(https?:|mailto:)/i.test(href || "");
    return allowed ? href : undefined;
}

/**
 * Raw fence text out of the renderer's `<code>` element. The element is
 * still unresolved, so its props carry the source string directly.
 * Anything unexpected falls back to rendering the children as-is.
 */
function fenceTextOf(children: React.ReactNode): string | null {
    const elements = Children.toArray(children);
    if (elements.length !== 1) return null;
    const only = elements[0];
    if (!isValidElement(only)) return null;
    const inner = (only.props as { children?: unknown }).children;
    return typeof inner === "string" ? inner : null;
}

const components = {
    a(props) {
        const href = linkHref(props.href);
        const external = /^https?:\/\//i.test(href || "");
        // The heading anchor arrives with its own classes; merge so the
        // hover-reveal styling survives the link color.
        const className = cn("text-info hover:text-info/70", props.className);
        if (external) {
            return (
                <ExternalLink {...props} href={href} className={className} />
            );
        }
        return <a {...props} href={href} className={className} />;
    },
    p(props) {
        return <p {...props} className="my-2 first:mt-0 last:mb-0" />;
    },
    // Headings merge the renderer's className: the footnotes heading ships
    // `sr-only`, which replacing the class list would un-hide.
    h1(props) {
        return (
            <h1
                {...props}
                className={cn(
                    "mt-3 mb-1 border-b pb-1 text-lg font-semibold first:mt-0",
                    props.className
                )}
            />
        );
    },
    h2(props) {
        return (
            <h2
                {...props}
                className={cn(
                    "mt-3 mb-1 border-b pb-1 text-base font-semibold first:mt-0",
                    props.className
                )}
            />
        );
    },
    h3(props) {
        return (
            <h3
                {...props}
                className={cn(
                    "mt-2 mb-1 font-semibold first:mt-0",
                    props.className
                )}
            />
        );
    },
    h4(props) {
        return (
            <h4
                {...props}
                className={cn(
                    "mt-2 mb-1 font-semibold first:mt-0",
                    props.className
                )}
            />
        );
    },
    ul(props) {
        return <ul {...props} className="my-2 list-disc space-y-1 pr-0 pl-6" />;
    },
    ol(props) {
        return (
            <ol {...props} className="my-2 list-decimal space-y-1 pr-0 pl-6" />
        );
    },
    blockquote(props) {
        return (
            <blockquote
                {...props}
                className="my-2 border-l-2 border-muted-foreground/40 pl-2 text-muted-foreground"
            />
        );
    },
    pre(props) {
        const { children } = props;
        const lang =
            "data-lang" in props && typeof props["data-lang"] === "string"
                ? props["data-lang"]
                : undefined;
        const text = fenceTextOf(children);
        if (text === null) {
            return (
                <Frame className="my-2">
                    <FramePanel className="overflow-x-auto p-2 font-mono">
                        {children}
                    </FramePanel>
                </Frame>
            );
        }
        // No highlighter in the template: the fence renders as monospace text
        // inside the same frame a highlighted block would use.
        return (
            <Frame className="my-2">
                <FramePanel className="overflow-x-auto p-2 font-mono">
                    <code className={lang ? `language-${lang}` : undefined}>
                        {text}
                    </code>
                </FramePanel>
            </Frame>
        );
    },
    code(props) {
        return (
            <code {...props} className="rounded bg-muted px-0.5 font-mono" />
        );
    },
    table({ children }) {
        return (
            <Frame className="my-2 w-full">
                <Table variant="card">{children}</Table>
            </Frame>
        );
    },
    thead(props) {
        return <TableHeader {...props} />;
    },
    tbody(props) {
        return <TableBody {...props} />;
    },
    tr(props) {
        return <TableRow {...props} />;
    },
    th(props) {
        return <TableHead {...props} className="whitespace-normal" />;
    },
    td(props) {
        return <TableCell {...props} className="whitespace-normal" />;
    },
    hr() {
        return <Separator className="my-3" />;
    },
    /** Tags that only exist because a markdown body carried HTML. The rest
     * resolve to real elements with no mapping, which React escapes. */
    [DETAILS_TAG]: MarkdownDetails,
    // The renderer hands every component node an empty child list, and React
    // rejects children on an intrinsic void element outright, so a void tag
    // needs a wrapper that drops them.
    br({ children: _voidChildren, ...props }) {
        return <br {...props} />;
    },
    wbr({ children: _voidChildren, ...props }) {
        return <wbr {...props} />;
    },
    kbd(props) {
        return <Kbd {...props} />;
    },
    sub(props) {
        return <sub {...props} className="text-xs" />;
    },
    sup(props) {
        return <sup {...props} className="text-xs" />;
    },
    mark(props) {
        return <mark {...props} className="rounded-sm bg-warning/24 px-0.5" />;
    },
    small(props) {
        return <small {...props} className="text-muted-foreground" />;
    },
    s(props) {
        return <s {...props} />;
    },
    del(props) {
        return <del {...props} />;
    },
    ins(props) {
        return <ins {...props} className="no-underline" />;
    },
    img({ children: _voidChildren, ...props }) {
        const src = props.src || "";
        if (TRUSTED_IMAGE_HOSTS.test(src)) {
            return <img {...props} className="max-w-full rounded-md" />;
        }
        const href = linkHref(src);
        if (!href) return null;
        return (
            <ExternalLink href={href} className="text-info hover:text-info/70">
                {props.alt || src}
            </ExternalLink>
        );
    },
    input(props) {
        if (props.type === "checkbox") {
            return (
                <Checkbox
                    checked={props.checked}
                    disabled
                    className="mr-1 align-middle"
                />
            );
        }
        return <input {...props} />;
    },
    [ALERT_TAG]: MarkdownAlert,
} satisfies MarkdownComponents;

/**
 * Renders a markdown body with the app's own components. Use it for any
 * untrusted markdown: the source is parsed with `allowHtml` so real tags stay
 * distinguishable from escaped text, and `safeHtmlExtension` rewrites every
 * html node into real elements first, so the renderer's innerHTML branch
 * never runs.
 */
export function MarkdownView({
    children,
    coords,
}: {
    children: React.ComponentProps<typeof Markdown>["children"];
    coords?: GithubCoords;
}) {
    const extensions = useMemo(
        () => [
            // Sanitizing runs first so the GitHub text rules see the tags as
            // plain text they can autolink around, rather than as nodes.
            safeHtmlExtension(),
            githubMarkdownExtension(coords),
        ],
        [coords]
    );
    return (
        <div className="min-w-0 break-words">
            <Markdown
                extensions={extensions}
                components={components}
                // Required so the parser can tell real html from escaped
                // `\<b>` text. It is safe because `safeHtmlExtension`
                // rewrites every html node before the renderer sees one, so
                // the renderer's innerHTML branch stays unreachable.
                allowHtml
            >
                {typeof children === "string"
                    ? normalizeHtmlBlocks(children)
                    : children}
            </Markdown>
        </div>
    );
}
