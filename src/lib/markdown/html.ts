import type {
    BlockNode,
    BlockParseContext,
    DocumentTransformContext,
    InlineComponentNode,
    InlineNode,
    ListItemNode,
    MarkdownDocument,
    MarkdownExtension,
    TableCellNode,
} from "@tanstack/markdown";

/** Tag the `<details>` block carries; the renderer maps it to a disclosure. */
export const DETAILS_TAG = "github-details";

/**
 * GitHub renders a safe subset of HTML inside markdown bodies, and the
 * dependabot bot leans on it hard: every release-notes block is a
 * `<details>`/`<summary>` pair and the version tables are raw HTML. Left
 * alone, those tags reach the UI as a wall of literal markup.
 *
 * The renderer escapes html unless `allowHtml` is set, and when it is set it
 * injects with `dangerouslySetInnerHTML`. So the source is parsed with
 * `allowHtml`, which is what makes real tags distinguishable from escaped
 * `\<b>` text, and every resulting node is then rewritten here. Nothing the
 * renderer receives is an html node, so the innerHTML branch is unreachable
 * and every text child is escaped by React. The allowlists below decide what
 * survives; the renderer builds real elements, never markup strings.
 */

/** Self-closing tags rendered as their real element. */
const VOID_TAGS = new Set(["br", "hr", "img", "wbr"]);

/** Tags whose open and close bracket a run of content. */
const PAIRED_TAGS = new Set([
    "a",
    "b",
    "blockquote",
    "code",
    "del",
    "div",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "i",
    "ins",
    "kbd",
    "li",
    "mark",
    "ol",
    "p",
    "pre",
    "s",
    "samp",
    "section",
    "small",
    "span",
    "strong",
    "sub",
    "sup",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "u",
    "ul",
    "var",
]);

/** Presentational tags whose content is worth keeping but whose element is
 * not, so dropping the wrapper alone is enough. */
const UNWRAPPED_TAGS = new Set([
    "article",
    "aside",
    "center",
    "figcaption",
    "figure",
    "font",
    "footer",
    "header",
    "main",
    "nav",
]);

/** Tags that own a block, promoted out of the paragraph the parser wrapped
 * them in. An html body arrives as one run of tags with no blank lines, so
 * without this a raw `<h2>` would sit inside a `<p>`. */
const HEADING_TAGS: Record<string, 1 | 2 | 3 | 4 | 5 | 6> = {
    h1: 1,
    h2: 2,
    h3: 3,
    h4: 4,
    h5: 5,
    h6: 6,
};

const TEXT_BLOCK_TAGS = new Set(["p", "div", "section"]);

/** Tags whose content is code or plugin-controlled markup rather than
 * prose, so the element and everything inside it is discarded. */
const DISCARDED_TAGS = new Set([
    "audio",
    "base",
    "button",
    "canvas",
    "embed",
    "form",
    "head",
    "iframe",
    "input",
    "link",
    "math",
    "meta",
    "noscript",
    "object",
    "option",
    "script",
    "select",
    "source",
    "style",
    "svg",
    "template",
    "textarea",
    "title",
    "track",
    "video",
]);

/** Attributes any tag may carry. Everything else, including every `on*`
 * handler, `style`, and `class`, is dropped. */
const GLOBAL_ATTRIBUTES = new Set(["title", "dir", "lang"]);

const TAG_ATTRIBUTES: Record<string, Set<string>> = {
    a: new Set(["href", "name"]),
    img: new Set(["src", "alt", "width", "height", "loading"]),
    details: new Set(["open"]),
    code: new Set(["class"]),
    p: new Set(["align"]),
    div: new Set(["align"]),
    h1: new Set(["align"]),
    h2: new Set(["align"]),
    h3: new Set(["align"]),
    h4: new Set(["align"]),
    h5: new Set(["align"]),
    h6: new Set(["align"]),
};

const URL_ATTRIBUTES = new Set(["href", "src"]);

const TAG_PATTERN =
    /^<(\/)?([A-Za-z][A-Za-z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>`]+))?)*)\s*(\/)?>$/;

/** Every tag token in a run of html, opening or closing. */
const TAG_SCAN =
    /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>`]+))?)*\s*\/?>/g;

/** Html comments, which carry no content but reach us as literal text from
 * bots that tag their output, for example `<!-- finishing_touch_suggestion
 * :docstrings -->`. */
const COMMENT_SCAN = /<!--[\s\S]*?-->/g;

interface ParsedTag {
    closing: boolean;
    selfClosing: boolean;
    name: string;
    attributes: Record<string, string>;
}

/** Only http(s), mailto, and relative references survive. Everything else,
 * including `javascript:`, `data:`, and `vbscript:`, is dropped. */
function safeUrl(value: string): string | undefined {
    const trimmed = value.trim();
    if (trimmed === "") return undefined;
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
    if (scheme === null) {
        // Protocol-relative urls inherit the app scheme, which is not a
        // browsing context.
        return trimmed.startsWith("//") ? undefined : trimmed;
    }
    return /^(https?|mailto):/i.test(trimmed) ? trimmed : undefined;
}

function parseAttributes(source: string): Record<string, string> {
    const attributes: Record<string, string> = {};
    const pattern =
        /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`]+)))?/g;
    for (const match of source.matchAll(pattern)) {
        const name = match[1]?.toLowerCase();
        if (name === undefined) continue;
        attributes[name] = match[2] ?? match[3] ?? match[4] ?? "";
    }
    return attributes;
}

function parseTag(source: string): ParsedTag | undefined {
    const match = TAG_PATTERN.exec(source.trim());
    if (match === null) return undefined;
    const name = (match[2] ?? "").toLowerCase();
    const raw = parseAttributes(match[3] ?? "");

    const allowed = TAG_ATTRIBUTES[name];
    const attributes: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
        if (!GLOBAL_ATTRIBUTES.has(key) && !allowed?.has(key)) continue;
        if (URL_ATTRIBUTES.has(key)) {
            const url = safeUrl(value);
            if (url === undefined) continue;
            attributes[key] = url;
            continue;
        }
        attributes[key] = value;
    }
    return {
        closing: match[1] !== undefined,
        selfClosing: match[4] !== undefined,
        name,
        attributes,
    };
}

function componentNode(tag: ParsedTag): InlineComponentNode {
    return {
        type: "inlineComponent",
        name: tag.name,
        attributes: tag.attributes,
        tagName: tag.name,
        properties: tag.attributes,
        // The renderer maps over this list, so it has to be present, but a
        // void element never receives content: `tokensToNodes` only fills it
        // in for a paired tag, and `renderHtml` below writes void elements
        // without a closing tag.
        children: [],
    };
}

/** Intermediate form between the parser's inline nodes and the final tree, so
 * one pairing pass serves both inline html and html found in a block. */
type Token =
    | { kind: "text"; value: string }
    | { kind: "opaque"; node: InlineNode }
    | { kind: "tag"; tag: ParsedTag };

/** Splits text carrying html tags into prose and tag tokens. Tags that are
 * not allowlisted leave only their text. */
function textToTokens(value: string): Token[] {
    const tokens: Token[] = [];
    let cursor = 0;
    for (const match of value.matchAll(TAG_SCAN)) {
        const start = match.index;
        if (start > cursor) {
            pushText(tokens, value.slice(cursor, start));
        }
        const tag = parseTag(match[0]);
        if (tag !== undefined) tokens.push({ kind: "tag", tag });
        cursor = start + match[0].length;
    }
    if (cursor < value.length) {
        pushText(tokens, value.slice(cursor));
    }
    return tokens;
}

/** Pushes text with any html comments removed, so a comment leaves nothing
 * behind. */
function pushText(tokens: Token[], value: string) {
    for (const piece of value.split(COMMENT_SCAN)) {
        if (piece.length > 0) tokens.push({ kind: "text", value: piece });
    }
}

function isHtmlComment(value: string): boolean {
    return value.startsWith("<!--") && value.endsWith("-->");
}

function inlineNodesToTokens(nodes: InlineNode[]): Token[] {
    const tokens: Token[] = [];
    for (const node of nodes) {
        if (node.type === "text") {
            tokens.push({ kind: "text", value: node.value });
            continue;
        }
        if (node.type === "inlineHtml") {
            // A comment is neither markup nor prose, so it is dropped whole.
            if (isHtmlComment(node.value)) continue;
            const tag = parseTag(node.value);
            // Not markup at all, for example a bare "<" in prose. Keeping it
            // as text is inert.
            if (tag === undefined) {
                tokens.push({ kind: "text", value: node.value });
            } else {
                tokens.push({ kind: "tag", tag });
            }
            continue;
        }
        if ("children" in node && Array.isArray(node.children)) {
            tokens.push({
                kind: "opaque",
                node: {
                    ...node,
                    children: rewriteInlineNodes(node.children),
                } as InlineNode,
            });
            continue;
        }
        tokens.push({ kind: "opaque", node });
    }
    return tokens;
}

interface OpenTag {
    name: string;
    /** Index into the token list where this tag's content begins. */
    start: number;
    node: InlineComponentNode;
}

/**
 * Removes a discarded tag together with everything up to its matching close,
 * so script and style bodies never surface as prose. The span is only cut
 * when the close tag is actually present, so an unclosed tag in a malformed
 * body cannot swallow the rest of the run.
 */
function dropDiscardedSpans(tokens: Token[]): Token[] {
    const out: Token[] = [];
    let cursor = 0;
    while (cursor < tokens.length) {
        const token = tokens[cursor] as Token;
        if (token.kind !== "tag" || token.tag.closing) {
            out.push(token);
            cursor += 1;
            continue;
        }
        if (!DISCARDED_TAGS.has(token.tag.name)) {
            out.push(token);
            cursor += 1;
            continue;
        }
        let close = -1;
        for (let index = cursor + 1; index < tokens.length; index += 1) {
            const candidate = tokens[index] as Token;
            if (candidate.kind !== "tag" || !candidate.tag.closing) continue;
            if (candidate.tag.name === token.tag.name) {
                close = index;
                break;
            }
        }
        if (close === -1) {
            out.push(token);
            cursor += 1;
            continue;
        }
        cursor = close + 1;
    }
    return out;
}

/**
 * Rebuilds the tokens as a real element tree, pairing open and close tags. A
 * tag left open at the end of a run drops its wrapper and keeps its content,
 * which is how a truncated body degrades.
 */
function tokensToNodes(tokens: Token[]): InlineNode[] {
    const out: InlineNode[] = [];
    const open: OpenTag[] = [];

    for (const token of dropDiscardedSpans(tokens)) {
        if (token.kind === "text") {
            out.push({ type: "text", value: token.value });
            continue;
        }
        if (token.kind === "opaque") {
            out.push(token.node);
            continue;
        }
        const tag = token.tag;
        if (DISCARDED_TAGS.has(tag.name)) continue;
        if (UNWRAPPED_TAGS.has(tag.name)) continue;
        if (VOID_TAGS.has(tag.name) || tag.selfClosing) {
            if (!tag.closing) out.push(componentNode(tag));
            continue;
        }
        if (!PAIRED_TAGS.has(tag.name)) continue;

        if (tag.closing) {
            let depth = -1;
            for (let index = open.length - 1; index >= 0; index -= 1) {
                if (open[index]?.name === tag.name) {
                    depth = index;
                    break;
                }
            }
            if (depth === -1) continue;
            const frame = open[depth] as OpenTag;
            // Tags still open inside this one were never closed; their content
            // stays in place rather than leaking out of this element.
            open.length = depth;
            out.push({ ...frame.node, children: out.splice(frame.start) });
            continue;
        }
        open.push({
            name: tag.name,
            start: out.length,
            node: componentNode(tag),
        });
    }
    return out;
}

function rewriteInlineNodes(nodes: InlineNode[]): InlineNode[] {
    return tokensToNodes(inlineNodesToTokens(nodes));
}

function textOf(nodes: InlineNode[]): string {
    return nodes
        .map((node) => {
            if (node.type === "text") return node.value;
            if (node.type === "inlineCode") return node.value;
            if ("children" in node && Array.isArray(node.children)) {
                return textOf(node.children);
            }
            return "";
        })
        .join("");
}

function isBlockComponent(node: InlineNode): node is InlineComponentNode {
    if (node.type !== "inlineComponent" || node.tagName === undefined) {
        return false;
    }
    return (
        node.tagName in HEADING_TAGS ||
        TEXT_BLOCK_TAGS.has(node.tagName) ||
        node.tagName === "blockquote" ||
        node.tagName === "ul" ||
        node.tagName === "ol" ||
        node.tagName === "li" ||
        node.tagName === "pre" ||
        node.tagName === "table"
    );
}

/** A list built out of `<li>` children, which is how dependabot writes its
 * change lists. */
function listOf(node: InlineComponentNode, ordered: boolean): BlockNode {
    const items: ListItemNode[] = node.children
        .filter((child) => isBlockComponent(child) && child.tagName === "li")
        .map((child) => {
            const children = (child as InlineComponentNode).children;
            return {
                type: "listItem",
                children: hasBlockChild(children)
                    ? promoteBlocks(children)
                    : [
                          {
                              type: "paragraph",
                              children: children as InlineNode[],
                          },
                      ],
            };
        });
    return {
        type: "list",
        ordered,
        items,
    };
}

function hasBlockChild(nodes: InlineNode[]): boolean {
    return nodes.some(isBlockComponent);
}

/** Lifts block-level html out of the paragraph the parser wrapped it in, so a
 * raw `<h2>` or `<ul>` becomes a real block again. Runs of inline content in
 * between are collected into paragraphs. */
function promoteBlocks(nodes: InlineNode[]): BlockNode[] {
    const blocks: BlockNode[] = [];
    let run: InlineNode[] = [];

    const flush = () => {
        if (run.length === 0) return;
        // Indentation between block tags is not content, so a run of nothing
        // but whitespace produces no paragraph at all.
        const content = run.filter(
            (node) => node.type !== "text" || node.value.trim() !== ""
        );
        if (content.length > 0) {
            blocks.push({ type: "paragraph", children: content });
        }
        run = [];
    };

    for (const node of nodes) {
        if (!isBlockComponent(node)) {
            run.push(node);
            continue;
        }
        const tag = node.tagName as string;
        flush();
        if (tag in HEADING_TAGS) {
            blocks.push({
                type: "heading",
                depth: HEADING_TAGS[tag] as 1 | 2 | 3 | 4 | 5 | 6,
                children: node.children,
            });
            continue;
        }
        if (TEXT_BLOCK_TAGS.has(tag)) {
            if (hasBlockChild(node.children)) {
                blocks.push(...promoteBlocks(node.children));
            } else {
                blocks.push({
                    type: "paragraph",
                    children: node.children,
                });
            }
            continue;
        }
        if (tag === "blockquote") {
            blocks.push({
                type: "blockquote",
                children: promoteBlocks(node.children),
            });
            continue;
        }
        if (tag === "ul" || tag === "ol") {
            blocks.push(listOf(node, tag === "ol"));
            continue;
        }
        if (tag === "li") {
            blocks.push(...promoteBlocks(node.children));
            continue;
        }
        if (tag === "pre") {
            blocks.push({ type: "code", value: textOf(node.children) });
            continue;
        }
        blocks.push(...promoteBlocks(node.children));
    }
    flush();
    return blocks;
}

function rewriteCell(cell: TableCellNode): TableCellNode {
    return { ...cell, children: rewriteInlineNodes(cell.children) };
}

/** A long html run can come back as several adjacent html blocks, which would
 * split a tag from its closing tag. They belong to one fragment, so they are
 * joined before tags are paired. */
function coalesceHtml(nodes: BlockNode[]): BlockNode[] {
    const out: BlockNode[] = [];
    let run: string[] = [];
    const flush = () => {
        if (run.length === 0) return;
        out.push({ type: "html", value: run.join("\n") });
        run = [];
    };
    for (const node of nodes) {
        if (node.type === "html") {
            run.push(node.value);
            continue;
        }
        flush();
        out.push(node);
    }
    flush();
    return out;
}

function rewriteBlockNodes(nodes: BlockNode[]): BlockNode[] {
    const out: BlockNode[] = [];
    for (const node of coalesceHtml(nodes)) {
        if (node.type === "html") {
            // No safe block form for the raw markup beyond the allowlist, so
            // it keeps its text and loses its tags. The renderer would inject
            // the value verbatim, which is exactly what must never happen.
            const content = promoteBlocks(
                tokensToNodes(textToTokens(node.value))
            );
            if (content.length > 0) out.push(...content);
            continue;
        }
        switch (node.type) {
            case "paragraph":
            case "heading":
                out.push({
                    ...node,
                    children: rewriteInlineNodes(node.children),
                });
                continue;
            case "blockquote":
            case "callout":
            case "component":
                out.push({
                    ...node,
                    children: rewriteBlockNodes(node.children),
                });
                continue;
            case "list":
                out.push({
                    ...node,
                    items: node.items.map((item) => ({
                        ...item,
                        children: rewriteBlockNodes(item.children),
                    })),
                });
                continue;
            case "footnotes":
                out.push({
                    ...node,
                    items: node.items.map((item) => ({
                        ...item,
                        children: rewriteBlockNodes(item.children),
                    })),
                });
                continue;
            case "table":
                out.push({
                    ...node,
                    header: node.header.map(rewriteCell),
                    rows: node.rows.map((row) => row.map(rewriteCell)),
                });
                continue;
            default:
                out.push(node);
        }
    }
    return out;
}

const DETAILS_OPEN =
    /^ {0,3}<details(?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>`]+))?)*\s*>\s*$/i;
const DETAILS_CLOSE = /^ {0,3}<\/details\s*>\s*$/i;
const SUMMARY_LINE = /^ {0,3}<summary[^>]*>(.*?)<\/summary\s*>\s*$/i;

/** Strips the inline markup a summary line may carry, so the disclosure
 * label stays plain text. */
function plainSummary(value: string): string {
    return value
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[*_`~]/g, "")
        .replace(/<[^>]*>/g, "")
        .trim();
}

/**
 * A `<details>` block, whose body stays markdown. Dependabot wraps every
 * release-notes section in one. An unclosed pair is left to the default
 * handling rather than swallowing the rest of the document.
 */
function parseDetails(context: BlockParseContext): BlockNode | undefined {
    const first = context.lines[context.index] ?? "";
    if (DETAILS_OPEN.test(first) === false) return undefined;

    const summary = context.lines[context.index + 1]?.match(SUMMARY_LINE);
    const bodyStart = context.index + 1 + (summary == null ? 0 : 1);
    let close = bodyStart;
    while (close < context.lines.length) {
        if (DETAILS_CLOSE.test(context.lines[close] ?? "")) break;
        close += 1;
    }
    if (close >= context.lines.length) return undefined;

    const body = context.lines.slice(bodyStart, close).join("\n");
    context.consume(close + 1 - context.index);
    return {
        type: "component",
        name: "details",
        attributes: {},
        tagName: DETAILS_TAG,
        properties: {
            "data-summary": plainSummary(summary?.[1] ?? "Details"),
            ...(DETAILS_OPEN.test(first) && /\bopen\b/i.test(first)
                ? { "data-open": "open" }
                : {}),
        },
        children: context.parseBlocks(body),
    };
}

const CELL_PATTERN = /<(t[dh])\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
const ROW_PATTERN = /<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi;

/**
 * A raw html table, which dependabot used for its before/after version
 * comparison. Cell content goes back through the inline parser so markdown
 * inside a cell still renders.
 */
function parseRawTable(context: BlockParseContext): BlockNode | undefined {
    const first = context.lines[context.index] ?? "";
    if (!/^ {0,3}<table\b/i.test(first)) return undefined;

    let close = context.index;
    while (close < context.lines.length) {
        if (/<\/table\s*>/i.test(context.lines[close] ?? "")) break;
        close += 1;
    }
    if (close >= context.lines.length) return undefined;

    const html = context.lines.slice(context.index, close + 1).join("\n");
    const rows = [...html.matchAll(ROW_PATTERN)].map((row) => [
        ...(row[1] ?? "").matchAll(CELL_PATTERN),
    ]);
    if (rows.length === 0) return undefined;

    const cellsOf = (row: RegExpMatchArray[]): TableCellNode[] =>
        row.map((cell) => ({
            type: "tableCell",
            children: context.parseInline((cell[2] ?? "").trim()),
        }));

    const header = rows[0]?.some((cell) => cell[1]?.toLowerCase() === "th")
        ? cellsOf(rows[0])
        : [];
    const body = (header.length > 0 ? rows.slice(1) : rows).map(cellsOf);

    context.consume(close + 1 - context.index);
    return {
        type: "table",
        align: [],
        header,
        rows: body,
    };
}

function escapeAttribute(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/**
 * The library's html renderer writes an open tag, the children, then a
 * closing tag, which turns a void element into `<br></br>`. An end tag is
 * forbidden on a void element, so those are written here instead: no
 * children, no close tag. Only sanitized attributes reach this, and they are
 * escaped again because this is raw markup.
 */
function renderVoidElement(node: BlockNode | InlineNode): string | undefined {
    if (node.type !== "inlineComponent" || node.tagName === undefined) {
        return undefined;
    }
    if (!VOID_TAGS.has(node.tagName)) return undefined;
    const attributes = Object.entries(node.properties ?? {})
        .map(([name, value]) => ` ${name}="${escapeAttribute(String(value))}"`)
        .join("");
    return `<${node.tagName}${attributes}>`;
}

/**
 * Tags that open a block in their own right. The parser only starts a block
 * at a blank line, so a `<details>` following a sentence with no blank line
 * between would stay inline and never reach `parseBlock`. GitHub lets these
 * interrupt a paragraph, and dependabot relies on it.
 */
const INTERRUPTING_TAGS =
    /^<(?:details|table|blockquote|ul|ol|dl|pre|h[1-6])\b/i;

/**
 * Puts a blank line before a block-level html tag that follows text on the
 * previous line, so it can start a block.
 */
export function normalizeHtmlBlocks(source: string): string {
    const lines = source.split("\n");
    const out: string[] = [];
    for (const line of lines) {
        const previous = out[out.length - 1];
        if (
            previous !== undefined &&
            previous.trim() !== "" &&
            INTERRUPTING_TAGS.test(line.trim())
        ) {
            out.push("");
        }
        out.push(line);
    }
    return out.join("\n");
}

function transformDocument(
    document: MarkdownDocument,
    _context: DocumentTransformContext
): MarkdownDocument {
    return { ...document, children: rewriteBlockNodes(document.children) };
}

export function safeHtmlExtension(): MarkdownExtension {
    return {
        name: "github-html",
        parseBlock: (context) =>
            parseDetails(context) ?? parseRawTable(context),
        transformDocument,
        renderHtml: renderVoidElement,
    };
}
