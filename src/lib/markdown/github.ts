import type {
    BlockNode,
    BlockParseContext,
    InlineNode,
    LinkNode,
    MarkdownDocument,
    MarkdownExtension,
} from "@tanstack/markdown";

export interface GithubCoords {
    owner: string;
    repo: string;
}

/** Tag the alert blocks carry; the renderer layer maps it to a component. */
export const ALERT_TAG = "md-alert";

// One pass over the text of a block, leftmost match first, so a bare URL wins
// over a mention inside it. The lookbehinds keep GitHub's rules: no mention in
// an email local part, no reference glued to a word, no autolink inside a path.
const INLINE_SOURCE = [
    "<(?<angle>https?://[^\\s<>]+)>",
    "<(?<angleMail>[^\\s<>@]+@[^\\s<>@]+\\.[^\\s<>@]+)>",
    "(?<![A-Za-z0-9@./-])(?<url>https?://[^\\s<>]+)",
    "(?<![A-Za-z0-9@./-])(?<bare>www\\.[^\\s<>.,][^\\s<>]*)",
    "(?<mail>[^\\s<>()\\[\\],;:!?'\"\\\\]+@[^\\s<>()\\[\\],;:!?'\"\\\\]+\\.[A-Za-z]{2,})",
    "(?<cross>[A-Za-z0-9][A-Za-z0-9._-]*/(?!/)[A-Za-z0-9][A-Za-z0-9._-]*#\\d+)",
    "(?<issue>(?<![A-Za-z0-9#])#\\d+(?![A-Za-z0-9_]))",
    "(?<mention>(?<![A-Za-z0-9_@/\\\\])@[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?(?:/(?<team>[A-Za-z0-9][A-Za-z0-9_.-]{0,99}))?)",
].join("|");

// Module level so the pattern is compiled once; only matchAll touches it, and
// matchAll clones the regex instead of advancing lastIndex.
const INLINE_PATTERN = new RegExp(INLINE_SOURCE, "g");

const URL_TRAILERS = new Set([
    ".",
    ",",
    ";",
    ":",
    "!",
    "?",
    "'",
    '"',
    "*",
    "_",
]);

/** GitHub leaves sentence punctuation out of the autolink, and drops a closing
 * paren only when the URL has no matching opening one. */
function trimUrlEnd(value: string): string {
    let end = value.length;
    while (end > 0) {
        const char = value.charAt(end - 1);
        if (URL_TRAILERS.has(char)) {
            end -= 1;
            continue;
        }
        if (
            char === ")" &&
            countChar(value.slice(0, end), ")") >
                countChar(value.slice(0, end), "(")
        ) {
            end -= 1;
            continue;
        }
        break;
    }
    return value.slice(0, end);
}

function countChar(value: string, char: string): number {
    let count = 0;
    for (const item of value) {
        if (item === char) count += 1;
    }
    return count;
}

/** Plain link nodes, so every reference lands in the renderer's existing link
 * treatment instead of a second one. */
function link(href: string, label: string): LinkNode {
    return {
        type: "link",
        href,
        children: [{ type: "text", value: label }],
    };
}

function referenceHref(owner: string, repo: string, number: string): string {
    return `https://github.com/${owner}/${repo}/issues/${number}`;
}

interface FoundLink {
    node: LinkNode;
    /** Matched characters the link covers; the rest stays plain text. */
    consumed: number;
}

function splitInlineText(
    value: string,
    coords: GithubCoords | undefined
): InlineNode[] {
    const nodes: InlineNode[] = [];
    let cursor = 0;
    for (const match of value.matchAll(INLINE_PATTERN)) {
        const start = match.index;
        if (start > cursor) {
            nodes.push({ type: "text", value: value.slice(cursor, start) });
        }
        const found = linkOf(match, coords);
        if (found === undefined) {
            nodes.push({ type: "text", value: match[0] });
        } else {
            nodes.push(found.node);
            // Sentence punctuation the URL pattern swallowed but the link
            // dropped stays in the text.
            const leftover = match[0].slice(found.consumed);
            if (leftover.length > 0) {
                nodes.push({ type: "text", value: leftover });
            }
        }
        cursor = start + match[0].length;
    }
    if (cursor < value.length) {
        nodes.push({ type: "text", value: value.slice(cursor) });
    }
    return nodes;
}

function linkOf(
    match: RegExpExecArray,
    coords: GithubCoords | undefined
): FoundLink | undefined {
    // The pattern is assembled from strings, so the named groups are invisible
    // to the type checker.
    const groups = (match.groups ?? {}) as Record<string, string | undefined>;
    const { angle, angleMail, url, bare, mail, cross, issue, mention, team } =
        groups;
    const whole = match[0].length;

    if (angle !== undefined) return found(link(angle, angle), whole);
    if (angleMail !== undefined)
        return found(link(`mailto:${angleMail}`, angleMail), whole);
    if (url !== undefined) return urlLink(url);
    if (bare !== undefined) return urlLink(bare, "https://");
    if (mail !== undefined) return found(link(`mailto:${mail}`, mail), whole);
    if (cross !== undefined) {
        const [slug, number] = splitReference(cross);
        return found(
            link(referenceHref(slug[0], slug[1], number), cross),
            whole
        );
    }
    if (issue !== undefined) {
        if (coords === undefined) return undefined;
        return found(
            link(
                referenceHref(coords.owner, coords.repo, issue.slice(1)),
                issue
            ),
            whole
        );
    }
    if (mention !== undefined) {
        const login = mention.slice(
            1,
            team === undefined ? undefined : -team.length - 1
        );
        const href =
            team === undefined
                ? `https://github.com/${login}`
                : `https://github.com/orgs/${login}/teams/${team}`;
        return found(link(href, mention), whole);
    }
    return undefined;
}

function found(node: LinkNode, consumed: number): FoundLink {
    return { node, consumed };
}

function urlLink(raw: string, scheme?: string): FoundLink | undefined {
    const value = trimUrlEnd(raw);
    if (!/^https?:\/\/[^\s]/.test(value) && !/^www\.[^\s.]/.test(value)) {
        return undefined;
    }
    const pullRequestNumber = githubPullRequestNumber(value);
    const label = pullRequestNumber ? `#${pullRequestNumber}` : value;
    return found(
        link(scheme ? `${scheme}${value}` : value, label),
        value.length
    );
}

function githubPullRequestNumber(value: string): string | undefined {
    try {
        const parsed = new URL(value);
        if (parsed.hostname !== "github.com") return undefined;
        return parsed.pathname.match(/^\/[^/]+\/[^/]+\/pull\/(\d+)\/?$/)?.[1];
    } catch {
        return undefined;
    }
}

function splitReference(value: string): [[string, string], string] {
    const hash = value.indexOf("#");
    const [owner, repo] = value.slice(0, hash).split("/");
    return [[owner, repo], value.slice(hash + 1)];
}

const CHILD_KEYS = ["children", "items", "header", "rows"] as const;

function isTextNode(value: unknown): value is { type: "text"; value: string } {
    return (
        typeof value === "object" &&
        value !== null &&
        (value as { type?: unknown }).type === "text" &&
        typeof (value as { value?: unknown }).value === "string"
    );
}

/**
 * Applies the GitHub text rules across the whole tree rather than to a
 * paragraph's inline nodes. A paragraph-only pass misses table cells,
 * heading runs, and text that arrived inside an html block, all of which
 * GitHub links too.
 */
function transformTextDeep(
    value: unknown,
    coords: GithubCoords | undefined
): unknown {
    if (Array.isArray(value)) {
        const out: unknown[] = [];
        for (const item of value) {
            if (isTextNode(item)) {
                out.push(...splitInlineText(item.value, coords));
            } else {
                out.push(transformTextDeep(item, coords));
            }
        }
        return out;
    }
    if (typeof value !== "object" || value === null) return value;
    const next: Record<string, unknown> = { ...value };
    // A link label is not re-linked, whether the link came from markdown or
    // from html in the body. Rewriting one nests an anchor inside an anchor
    // and, worse, repoints it: dependabot writes
    // `<a href=".../facebook/react/pull/36236">#36236</a>`, whose label would
    // otherwise become a link to this repository's issue 36236.
    if (next.type === "link") return next;
    if (next.type === "inlineComponent" && next.tagName === "a") return next;
    for (const key of CHILD_KEYS) {
        if (key in next) next[key] = transformTextDeep(next[key], coords);
    }
    return next;
}

const ALERT_KINDS = new Set(["note", "tip", "important", "warning", "caution"]);

/** `> [!NOTE]` and its five siblings. An unknown kind is left to the blockquote
 * parser, which is what GitHub does with it too. */
function parseAlert(context: BlockParseContext): BlockNode | undefined {
    const match = (context.lines[context.index] ?? "").match(
        /^ {0,3}>[ \t]*\[!([A-Za-z]+)\][ \t]*(.*)$/
    );
    if (!match) return undefined;
    const kind = match[1].toLowerCase();
    if (!ALERT_KINDS.has(kind)) return undefined;

    const body: string[] = [];
    let cursor = context.index + 1;
    while (cursor < context.lines.length) {
        const quoted = (context.lines[cursor] ?? "").match(
            /^ {0,3}>[ \t]?(.*)$/
        );
        if (!quoted) break;
        body.push(quoted[1]);
        cursor += 1;
    }

    context.consume(cursor - context.index);
    return {
        type: "component",
        name: "alert",
        attributes: { kind },
        tagName: ALERT_TAG,
        properties: { "data-kind": kind, "data-title": match[2].trim() },
        children: context.parseBlocks(body.join("\n")),
    };
}

const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;

/** Block openers the parser would claim first. A table header cannot be one:
 * its delimiter row carries one cell per header cell, so a pure `=` or `-`
 * line never matches a real one. */
function startsBlock(line: string): boolean {
    return (
        /^ {0,3}(?:`{3,}|~{3,}|#{1,6}(?:[ \t]|$)|>|<!--|<[A-Za-z])/.test(
            line
        ) ||
        /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line) ||
        /^ {0,8}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/.test(line)
    );
}

/** `Title` followed by `===` or `---` is a heading on GitHub, not a paragraph
 * followed by a rule. Only the last line may underline the whole run, which is
 * how multi-line setext headings resolve. */
function parseSetextHeading(context: BlockParseContext): BlockNode | undefined {
    const first = context.lines[context.index] ?? "";
    if (first.trim() === "" || startsBlock(first)) return undefined;

    const collected: string[] = [];
    let cursor = context.index;
    while (cursor < context.lines.length) {
        const line = context.lines[cursor] ?? "";
        if (line.trim() === "") break;
        collected.push(line.trim());
        cursor += 1;
    }
    const underline = collected.pop() ?? "";
    const depth = SETEXT_UNDERLINE.test(underline)
        ? underline.trimStart().startsWith("=")
            ? 1
            : 2
        : undefined;
    if (depth === undefined || collected.length === 0) return undefined;

    context.consume(cursor - context.index);
    return {
        type: "heading",
        depth,
        children: context.parseInline(collected.join(" ")),
    };
}

export function githubMarkdownExtension(
    coords?: GithubCoords
): MarkdownExtension {
    return {
        name: "github",
        parseBlock: (context) =>
            parseAlert(context) ?? parseSetextHeading(context),
        transformDocument: (document) =>
            transformTextDeep(document, coords) as MarkdownDocument,
    };
}
