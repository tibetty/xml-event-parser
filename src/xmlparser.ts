/**
 * One parsed element.
 *
 * Attributes are copied onto the node as own properties (flat, so a document
 * costs one object per element), which is why the type carries an index
 * signature. `text` is set only for elements without child elements.
 */
export interface XmlNode {
    tagName: string;
    children?: XmlNode[];
    text?: string;
    [attribute: string]: any;
}

/** Listener signature for the path-based events. */
export type XmlListener = (node: XmlNode, parent?: XmlNode) => void;

/** XML 1.0 `Char`: the code points a character reference may name (§2.2, §4.1). */
function isXmlChar(code: number): boolean {
    return code >= 0x20
        ? code <= 0xD7FF || (code >= 0xE000 && code <= 0xFFFD) || (code >= 0x10000 && code <= 0x10FFFF)
        : code === 0x9 || code === 0xA || code === 0xD;
}

/**
 * Decode one character reference body (between `&#` and `;`), or `null` when
 * the digits are malformed or name a character XML forbids.
 */
function decodeCharRef(value: string, from: number, to: number): string | null {
    let code = 0;
    const x = value.charCodeAt(from);
    const hex = x === 120 || x === 88; // 'x', or 'X' as browsers accept
    let i = hex ? from + 1 : from;
    if (i >= to) {
        return null;
    }
    for (; i < to; i++) {
        const c = value.charCodeAt(i);
        let digit: number;
        if (c >= 48 && c <= 57) {
            digit = c - 48;
        } else if (hex && c >= 97 && c <= 102) {
            digit = c - 87;
        } else if (hex && c >= 65 && c <= 70) {
            digit = c - 55;
        } else {
            return null;
        }
        code = code * (hex ? 16 : 10) + digit;
        if (code > 0x10FFFF) {
            return null;
        }
    }
    return isXmlChar(code) ? String.fromCodePoint(code) : null;
}

/** Decode one entity (between `&` and `;`), or `null` if it is not one. */
function decodeEntity(value: string, from: number, to: number): string | null {
    if (value.charCodeAt(from) === 35) { // '#'
        return decodeCharRef(value, from + 1, to);
    }
    switch (value.slice(from, to)) {
        case 'amp': return '&';
        case 'lt': return '<';
        case 'gt': return '>';
        case 'quot': return '"';
        case 'apos': return "'";
    }
    return null;
}

/**
 * Decode XML entities.
 *
 * A manual scan beats `String.replace` with a callback by ~2.5x on OSM-sized
 * attribute values: no regex, no match object and no per-entity closure. The
 * `indexOf` guard keeps entity-free values allocation-free. An `&` that does
 * not start a well-formed reference is kept as written, and the scan resumes
 * at the next `&`, so `AT&T &lt;` still decodes the `&lt;`.
 */
export function decodeEntities(value: string): string {
    let at = value.indexOf('&');
    if (at < 0) {
        return value;
    }
    let out = '';
    let copied = 0;
    let semi = -1;
    while (at >= 0) {
        if (semi <= at) {
            semi = value.indexOf(';', at + 1);
            if (semi < 0) {
                break;
            }
        }
        const decoded = decodeEntity(value, at + 1, semi);
        if (decoded === null) {
            at = value.indexOf('&', at + 1);
            continue;
        }
        out += value.slice(copied, at) + decoded;
        copied = semi + 1;
        at = value.indexOf('&', copied);
    }
    return copied === 0 ? value : out + value.slice(copied);
}

const CRLF = /\r\n?/g;
const ATTR_SPACE = /\r\n|[\t\n\r]/g;

/**
 * Normalise and decode an attribute value (XML 1.0 §3.3.3): a literal tab, CR,
 * LF or CRLF pair becomes one space before entities are decoded, so whitespace
 * written as a character reference (`&#10;`) survives. The caller says whether
 * the value holds any of those characters (see `XmlParser.hasControl`).
 */
function decodeAttribute(raw: string, hasControl: boolean): string {
    if (hasControl) {
        raw = raw.replace(ATTR_SPACE, ' ');
    }
    return raw.indexOf('&') < 0 ? raw : decodeEntities(raw);
}

/**
 * Decode the content of a text-only element. CDATA sections contribute their
 * text verbatim (per XML, entities inside CDATA are not references), comments
 * and processing instructions contribute nothing, and everything else is
 * entity-decoded. The common case - no markup - is one `indexOf` and the
 * existing fast path. An unterminated comment or PI (truncated input) drops
 * the rest; an unterminated CDATA section keeps it.
 */
function decodeContent(raw: string, hasCR: boolean): string {
    if (hasCR) {
        raw = raw.replace(CRLF, '\n'); // XML 1.0 §2.11 end-of-line handling
    }
    let lt = raw.indexOf('<');
    if (lt < 0) {
        return raw.indexOf('&') < 0 ? raw : decodeEntities(raw);
    }
    let out = '';
    let at = 0;
    while (lt >= 0) {
        if (lt > at) {
            out += decodeEntities(raw.slice(at, lt));
        }
        let end: number;
        if (raw.startsWith('<![CDATA[', lt)) {
            end = raw.indexOf(']]>', lt + 9);
            if (end < 0) {
                return out + raw.slice(lt + 9);
            }
            out += raw.slice(lt + 9, end);
            at = end + 3;
        } else if (raw.startsWith('<!--', lt)) {
            end = raw.indexOf('-->', lt + 4);
            if (end < 0) {
                return out;
            }
            at = end + 3;
        } else if (raw.charCodeAt(lt + 1) === 63) { // '?'
            end = raw.indexOf('?>', lt + 2);
            if (end < 0) {
                return out;
            }
            at = end + 2;
        } else if (raw.charCodeAt(lt + 1) === 33) { // '!': a doctype or other declaration
            end = raw.indexOf('>', lt + 2);
            if (end < 0) {
                return out;
            }
            at = end + 1;
        } else {
            out += '<';
            at = lt + 1;
        }
        lt = raw.indexOf('<', at);
    }
    return at < raw.length ? out + decodeEntities(raw.slice(at)) : out;
}

// character codes used by the scanner
const LT = 60;        // <
const GT = 62;        // >
const SLASH = 47;     // /
const BANG = 33;      // !
const QUESTION = 63;  // ?
const EQUALS = 61;    // =
const DQUOTE = 34;    // "
const SQUOTE = 39;    // '
const SPACE = 32;
const TAB = 9;
const LF = 10;
const CR = 13;

/** Number of dotted segments in a path: `'a.b'` is 2, `''` is 0. */
function segments(path: string): number {
    if (path.length === 0) {
        return 0;
    }
    let count = 1;
    for (let at = path.indexOf('.'); at >= 0; at = path.indexOf('.', at + 1)) {
        count++;
    }
    return count;
}

/** `'</a.b>'` and `'a.b'` both normalise to `'a.b'`. */
function normalizePath(path: string): string {
    let start = 0;
    let end = path.length;
    if (path.charCodeAt(0) === LT) {
        start = path.charCodeAt(1) === SLASH ? 2 : 1;
    }
    if (path.charCodeAt(end - 1) === GT) {
        end--;
    }
    return path.slice(start, end);
}

/** `'<a.b>'` or `'</a.b>'`: non-empty dotted segments without spaces or markup. */
const EVENT_NAME = /^<\/?[^\s<>/.]+(?:\.[^\s<>/.]+)*>$/;

/**
 * Whether `c` can start an XML name (§2.3 `NameStartChar`, with every non-ASCII
 * code unit accepted). A `<` followed by anything else is text, so `1 < 2`
 * stays text instead of opening an element with an empty name.
 */
function isNameStart(c: number): boolean {
    return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 58 || c >= 0x80;
}

function isSpace(c: number): boolean {
    return c === SPACE || c === TAB || c === LF || c === CR;
}

/**
 * Copy an attribute onto a node. `tagName`, `children` and `text` belong to the
 * parser, so attributes with those names are dropped. `__proto__` is defined as
 * an own data property, so input cannot change a node's prototype.
 */
function setAttribute(node: XmlNode, name: string, value: string): void {
    if (name === 'tagName' || name === 'children' || name === 'text') {
        return;
    }
    if (name === '__proto__') {
        Object.defineProperty(node, name, { value, writable: true, enumerable: true, configurable: true });
        return;
    }
    node[name] = value;
}

interface Frame {
    node: XmlNode;
    /**
     * Dotted path from the root. Built only when `depth` is within
     * `XmlParser.pathDepth`; deeper frames hold `''`, because no listener or
     * `keep` path can match them.
     */
    fullTag: string;
    /** Number of segments in this frame's path, counting a `parse()` dir prefix. */
    depth: number;
    textStart: number;
    /** Retained subtree: this element or an ancestor matched `keep`. */
    keep?: boolean;
    /**
     * Whether a child element was parsed inside this one. Text is only kept for
     * elements without children, and the flag is what lets the scanner drop
     * consumed input: a frame with children never needs its text start again.
     * (`node.children` cannot answer this under `retain: 'none'`, where
     * children are deliberately not attached.)
     */
    hasChild?: boolean;
}

export type Retain = 'all' | 'root' | 'none';

export interface XmlParserOptions {
    /** Emit `<path>` / `</path>` events as elements open and close. Default `false`. */
    progressive?: boolean;
    /** Track parents so `getParent(node)` works. Default `false`. */
    queryParent?: boolean;
    /**
     * What the parser keeps after an element closes:
     * - `'all'` (default) the whole document tree, returned by `end()`
     * - `'root'` the root being built; a finished top-level element is emitted
     *   and dropped, so memory is bounded by the largest root
     * - `'none'` nothing; every element is emitted and dropped, so memory is
     *   bounded by the nesting depth. Combine with listeners: an element
     *   nobody listens for is parsed and discarded.
     */
    retain?: Retain;
    /**
     * Under `retain: 'none'`, elements whose dotted path is listed here keep
     * their subtree (children and text), so a streamed element arrives
     * complete instead of as a bare tag. Paths use the event form without
     * brackets: `'testsuites.testsuite.testcase'`.
     *
     * Memory stays bounded by the largest matched subtree, not the document.
     */
    keep?: string[];
}

interface OpenTag {
    node: XmlNode;
    tag: string;
    selfClose: boolean;
    end: number;
}

export class XmlParser {
    private queryParent: boolean = false;
    private progressive: boolean = false;
    private retain: Retain = 'all';
    private keepPaths: Set<string> = new Set();
    private parentMap: WeakMap<XmlNode, XmlNode> = new WeakMap();
    private evtListeners: { [k: string]: XmlListener[] } = {};
    /**
     * Number of registered open-tag (`<path>`) listeners; lets the scanner skip
     * building open-event strings for the overwhelmingly common leaf elements.
     */
    private openListenerCount: number = 0;
    /**
     * Exact paths that have at least one listener, the child paths keyed by
     * their parent path, and top-level listeners. These let the scanner skip
     * building event strings for the many `<nd>`/`<tag>` leaves that nobody
     * observes.
     */
    private watchedPaths: Set<string> = new Set();
    private watchedChildren: Map<string, Set<string>> = new Map();
    private watchedTopLevel: Set<string> = new Set();
    /**
     * Segments in the deepest watched or kept path. Elements deeper than this
     * build no path string and skip every lookup, so a deeply nested document
     * costs O(depth) rather than O(depth²): each lookup would flatten a path
     * string as long as the depth.
     */
    private pathDepth: number = 0;
    /** Segments in the `parse()` dir prefix. */
    private baseDepth: number = 0;

    /** Input not consumed yet: pending text plus any construct split by a chunk. */
    private buffer: string = '';
    /** Next position to scan in `buffer`. */
    private cursor: number = 0;
    private stack: Frame[] = [];
    private roots: XmlNode[] = [];
    private top: Frame | undefined;
    /**
     * Per control character (tab, LF, CR - see `slotOf`), the next position in
     * `buffer` at or after `nextFrom`, or `Infinity` when there is none. Asking
     * whether a short attribute value or text run holds one is then a compare
     * instead of a scan, and each character class is scanned once per
     * occurrence rather than once per value. Reset whenever `buffer` changes.
     */
    private nextAt: number[] = [-1, -1, -1];
    private nextFrom: number[] = [Infinity, Infinity, Infinity];
    private rootOwner: Frame | undefined;
    private basePath: string = '';
    private active: boolean = false;

    constructor(opts?: XmlParserOptions) {
        if (opts) {
            this.queryParent = opts.queryParent === true;
            this.progressive = opts.progressive === true;
            if (opts.retain) {
                this.retain = opts.retain;
            }
            if (opts.keep) {
                for (const path of opts.keep) {
                    const normalized = normalizePath(path);
                    this.keepPaths.add(normalized);
                    this.pathDepth = Math.max(this.pathDepth, segments(normalized));
                }
            }
        }
    }

    /**
     * Feed a chunk of XML.
     *
     * Chunks may split anywhere: inside a tag, an attribute value, a comment, a
     * CDATA section or a text run. Anything incomplete is kept and resumed on
     * the next `write()`; call `end()` when the input is exhausted.
     */
    public write(chunk: string): this {
        if (!this.active) {
            this.begin(undefined, undefined);
        }
        if (chunk.length === 0) {
            return this;
        }
        if (this.buffer.length === 0) {
            this.buffer = chunk;
        } else {
            this.buffer += chunk;
        }
        this.consume(false);
        return this;
    }

    /**
     * Finish the document: close elements still open at the end of input and
     * return the top-level nodes (empty for `retain: 'root' | 'none'`).
     */
    public end(): XmlNode[] {
        if (!this.active) {
            return [];
        }
        this.consume(true);
        this.finish();
        const roots = this.roots;
        this.reset();
        return roots;
    }

    /**
     * Parse a complete XML string in one pass.
     *
     * Equivalent to `write(xml).end()`, and the only entry point you need
     * unless the document arrives in pieces.
     *
     * @param xml - the XML source to scan.
     * @param parent - optional pre-existing node that owns the parsed content;
     * when supplied, top-level nodes attach to its `children` instead of being
     * returned as roots.
     * @param dir - optional dotted tag-path prefix applied to emitted event names.
     * @returns the top-level nodes (empty when a `parent` owns them).
     */
    public parse(xml: string, parent?: XmlNode, dir?: string): XmlNode[] {
        this.begin(parent, dir);
        this.write(xml);
        return this.end();
    }

    private begin(parent: XmlNode | undefined, dir: string | undefined): void {
        this.buffer = '';
        this.cursor = 0;
        this.stack = [];
        this.roots = [];
        this.basePath = dir ? dir : '';
        this.baseDepth = segments(this.basePath);
        this.top = parent ? { node: parent, fullTag: this.basePath, depth: this.baseDepth, textStart: 0 } : undefined;
        this.rootOwner = this.top;
        this.parentMap = new WeakMap();
        this.active = true;
    }

    private reset(): void {
        this.buffer = '';
        this.cursor = 0;
        this.stack = [];
        this.roots = [];
        this.top = undefined;
        this.rootOwner = undefined;
        this.basePath = '';
        this.baseDepth = 0;
        this.active = false;
    }

    /**
     * Store a closed element according to the retention mode.
     *
     * `parentNode === undefined` means the element is top-level (a root), which
     * `retain: 'root'` drops after emitting it.
     */
    private attach(node: XmlNode, parentNode: XmlNode | undefined, keepParent: boolean): void {
        if (this.retain === 'none' && !keepParent) {
            return;
        }
        if (parentNode === undefined) {
            if (this.retain === 'all') {
                this.roots.push(node);
            }
            return;
        }
        const children = parentNode.children;
        if (children) {
            children.push(node);
        } else {
            parentNode.children = [node];
        }
    }

    /** Scan everything in `buffer` that is complete, or all of it at `end()`. */
    private consume(final: boolean): void {
        this.nextAt = [-1, -1, -1];
        this.nextFrom = [Infinity, Infinity, Infinity];
        const xml = this.buffer;
        const len = xml.length;
        const progressive = this.progressive;
        const hasOpenListeners = progressive && this.openListenerCount > 0;
        let i = this.cursor;
        // Set when the buffer ends inside a construct we cannot finish yet.
        let pending = -1;

        while (i < len) {
            const lt = xml.indexOf('<', i);
            if (lt < 0) {
                break;
            }
            pending = lt;
            i = lt + 1;
            if (i >= len) {
                break;
            }
            const c = xml.charCodeAt(i);

            if (c === SLASH) {
                // closing tag: </tag>; at end of input an unterminated one
                // still closes the element, so '<a>t</a' reads as 't'.
                let gt = xml.indexOf('>', i);
                if (gt < 0) {
                    if (!final) {
                        break;
                    }
                    gt = len - 1;
                }
                const frame = this.stack.pop();
                i = gt + 1;
                pending = -1;
                if (!frame) {
                    continue;
                }
                const node = frame.node;
                const parentFrame = this.stack.length ? this.stack[this.stack.length - 1] : this.rootOwner;
                const parentNode = parentFrame ? parentFrame.node : undefined;

                if (!frame.hasChild && lt > frame.textStart) {
                    const text = decodeContent(xml.slice(frame.textStart, lt), this.has(CR, frame.textStart, lt));
                    if (text) {
                        node.text = text;
                    }
                }

                if (progressive && frame.depth <= this.pathDepth && this.watchedPaths.has(frame.fullTag)) {
                    this.emit('</' + frame.fullTag + '>', node, parentNode);
                }

                this.attach(node, parentNode, parentFrame ? parentFrame.keep === true : false);
                if (parentFrame) {
                    parentFrame.hasChild = true;
                }
                this.top = parentFrame;
                continue;
            }

            if (c === QUESTION) {
                // processing instruction: <? ... ?>
                const gt = xml.indexOf('?>', i + 1);
                if (gt < 0) {
                    if (!final) {
                        break;
                    }
                    i = len;
                    break;
                }
                i = gt + 2;
                pending = -1;
                continue;
            }

            if (c === BANG) {
                // comment, CDATA or doctype
                let end: number;
                if (xml.charCodeAt(i + 1) === 45 && xml.charCodeAt(i + 2) === 45) {
                    end = xml.indexOf('-->', i + 3);
                    end = end < 0 ? -1 : end + 3;
                } else if (xml.startsWith('![CDATA[', i)) {
                    // CDATA is content, not markup: skip to its terminator so
                    // '<' and '>' inside it are not read as elements. The
                    // closing-tag branch turns the slice into text, and
                    // decodeContent() keeps it verbatim.
                    end = xml.indexOf(']]>', i + 9);
                    end = end < 0 ? -1 : end + 3;
                } else {
                    end = xml.indexOf('>', i);
                    end = end < 0 ? -1 : end + 1;
                }
                if (end < 0) {
                    if (!final) {
                        break;
                    }
                    i = len;
                    break;
                }
                i = end;
                pending = -1;
                continue;
            }

            if (!isNameStart(c)) {
                // not markup: the '<' stays in the text run
                pending = -1;
                continue;
            }

            const opened = this.parseOpenTag(xml, i, len, final);
            if (opened === null) {
                break;
            }
            i = opened.end;
            pending = -1;
            const node = opened.node;
            const tag = opened.tag;
            const parentNode = this.top ? this.top.node : undefined;

            if (this.queryParent && parentNode) {
                this.parentMap.set(node, parentNode);
            }

            // '?'/'!' prefixed tags were already routed above; treat trailing
            // '/' (and the implicitly self-closing prolog tags) as leaves.
            const depth = (this.top ? this.top.depth : this.baseDepth) + 1;
            const tracked = depth <= this.pathDepth;
            if (opened.selfClose) {
                if (progressive && tracked) {
                    const parentTag = this.top ? this.top.fullTag : this.basePath;
                    const watched = parentTag
                        ? this.watchedChildren.get(parentTag)
                        : this.watchedTopLevel;
                    if (watched && watched.has(tag)) {
                        const fullTag = parentTag ? parentTag + '.' + tag : tag;
                        if (hasOpenListeners) {
                            this.emit('<' + fullTag + '>', node, parentNode);
                        }
                        this.emit('</' + fullTag + '>', node, parentNode);
                    }
                }
                this.attach(node, parentNode, this.top ? this.top.keep === true : false);
                if (this.top) {
                    this.top.hasChild = true;
                }
                continue;
            }

            let fullTag = '';
            let keep = this.top !== undefined && this.top.keep === true;
            if (tracked) {
                fullTag = this.top
                    ? (this.top.fullTag ? this.top.fullTag + '.' + tag : tag)
                    : (this.basePath ? this.basePath + '.' + tag : tag);
                if (hasOpenListeners && this.watchedPaths.has(fullTag)) {
                    this.emit('<' + fullTag + '>', node, parentNode);
                }
                if (!keep && this.keepPaths.size > 0) {
                    keep = this.keepPaths.has(fullTag);
                }
            }
            const frame: Frame = { node, fullTag, depth, textStart: i, keep };
            this.stack.push(frame);
            this.top = frame;
        }

        this.cursor = final ? len : (pending >= 0 ? pending : i);
        if (!final) {
            this.compact();
        }
    }

    /**
     * Parse one opening tag at `from` (just past `<`).
     *
     * Returns `null` when the tag is not complete and more input may follow; at
     * `final` an unterminated tag is accepted as far as it goes, which is what
     * keeps truncated documents usable.
     */
    private parseOpenTag(xml: string, from: number, len: number, final: boolean): OpenTag | null {
        let j = from;
        while (j < len) {
            const ch = xml.charCodeAt(j);
            if (isSpace(ch) || ch === SLASH || ch === GT) {
                break;
            }
            j++;
        }
        if (j >= len && !final) {
            return null;
        }
        const tag = xml.slice(from, j);
        const node: XmlNode = { tagName: tag };
        let selfClose = false;

        while (j < len) {
            let ch = xml.charCodeAt(j);
            while (j < len && isSpace(ch)) {
                ch = xml.charCodeAt(++j);
            }
            if (j >= len) {
                break;
            }
            if (ch === GT) {
                j++;
                return { node, tag, selfClose, end: j };
            }
            if (ch === SLASH) {
                selfClose = true;
                j++;
                continue;
            }

            const nameStart = j;
            while (j < len) {
                ch = xml.charCodeAt(j);
                if (ch === EQUALS || isSpace(ch) || ch === GT || ch === SLASH) {
                    break;
                }
                j++;
            }
            if (j >= len && !final) {
                return null;
            }
            const attrName = xml.slice(nameStart, j);

            while (j < len && isSpace(xml.charCodeAt(j))) {
                j++;
            }
            if (j >= len && !final) {
                return null;
            }
            if (xml.charCodeAt(j) === EQUALS) {
                j++;
                while (j < len && isSpace(xml.charCodeAt(j))) {
                    j++;
                }
                if (j >= len && !final) {
                    return null;
                }
                const q = xml.charCodeAt(j);
                if (q === DQUOTE || q === SQUOTE) {
                    j++;
                    let valEnd = xml.indexOf(q === DQUOTE ? '"' : "'", j);
                    if (valEnd < 0) {
                        if (!final) {
                            return null;
                        }
                        valEnd = len;
                    }
                    const raw = xml.slice(j, valEnd);
                    setAttribute(node, attrName, decodeAttribute(raw, this.hasControl(j, valEnd)));
                    j = valEnd + 1;
                }
            } else if (attrName) {
                setAttribute(node, attrName, '');
            }
        }

        if (!final) {
            return null;
        }
        return { node, tag, selfClose, end: j };
    }

    /**
     * Close elements still open at the end of input instead of dropping them:
     * a truncated download keeps the document parsed so far.
     */
    private finish(): void {
        const xml = this.buffer;
        let trailing = xml.length;
        while (this.stack.length > 0) {
            const frame = this.stack.pop()!;
            const node = frame.node;
            if (!frame.hasChild && trailing > frame.textStart) {
                const raw = xml.slice(frame.textStart, trailing);
                const text = decodeContent(raw, raw.indexOf('\r') >= 0);
                if (text) {
                    node.text = text;
                }
                trailing = frame.textStart;
            }
            const parentFrame = this.stack.length ? this.stack[this.stack.length - 1] : this.rootOwner;
            const parentNode = parentFrame ? parentFrame.node : undefined;
            this.attach(node, parentNode, parentFrame ? parentFrame.keep === true : false);
        }
    }

    /**
     * Drop consumed input.
     *
     * Everything before the innermost open element is dead: its text has not
     * been read yet, and ancestors with children never read theirs. Keeping the
     * buffer from there is what makes a streamed document cost the pending text
     * rather than the whole file.
     */
    private compact(): void {
        let keepFrom = this.cursor;
        for (let i = this.stack.length - 1; i >= 0; i--) {
            const frame = this.stack[i];
            if (!frame.hasChild) {
                keepFrom = frame.textStart;
                break;
            }
        }
        if (keepFrom <= 0) {
            return;
        }
        this.buffer = this.buffer.slice(keepFrom);
        this.cursor -= keepFrom;
        for (let i = 0; i < this.stack.length; i++) {
            const frame = this.stack[i];
            frame.textStart = frame.textStart > keepFrom ? frame.textStart - keepFrom : 0;
        }
        if (this.rootOwner) {
            this.rootOwner.textStart = 0;
        }
    }

    /**
     * Build the missing paths of open elements after `pathDepth` grows, so a
     * listener added between `write()` calls sees elements that are already
     * open. Only frames within the new depth are touched.
     */
    private retrack(): void {
        let parentTag = this.rootOwner ? this.rootOwner.fullTag : this.basePath;
        for (let k = 0; k < this.stack.length; k++) {
            const frame = this.stack[k];
            if (frame.depth > this.pathDepth) {
                break;
            }
            if (frame.fullTag === '') {
                frame.fullTag = parentTag ? parentTag + '.' + frame.node.tagName : frame.node.tagName;
            }
            parentTag = frame.fullTag;
        }
    }

    /** Whether `buffer[from, to)` holds the control character `code`. */
    private has(code: number, from: number, to: number): boolean {
        const slot = code === TAB ? 0 : code === LF ? 1 : 2;
        let at = this.nextAt[slot];
        if (from < this.nextFrom[slot] || from > at) {
            at = this.buffer.indexOf(String.fromCharCode(code), from);
            if (at < 0) {
                at = Infinity;
            }
            this.nextAt[slot] = at;
            this.nextFrom[slot] = from;
        }
        return at < to;
    }

    /** Whether `buffer[from, to)` holds a tab, LF or CR. */
    private hasControl(from: number, to: number): boolean {
        return this.has(LF, from, to) || this.has(TAB, from, to) || this.has(CR, from, to);
    }

    /** Parent of a node parsed with `queryParent: true`, otherwise `null`. */
    public getParent(node: any): any {
        if (this.queryParent) {
            return this.parentMap.get(node);
        }
        return null;
    }

    /**
     * Register a listener for an event.
     *
     * Event names are the dotted tag path, prefixed with `<` for an opening
     * element and `</` for a closing one: `'<osm.way>'`, `'</osm.way>'`.
     * Filter inside the listener - `if (node.tagName !== 'way') return;` - and
     * an unobserved path costs nothing, because the scanner skips building
     * event names nobody listens for.
     */
    public addListener(evt: string, func: XmlListener) {
        this.$addListener(evt, func);
    }

    public removeListener(evt: string, func: XmlListener) {
        this.$removeListener(evt, func);
    }

    public on(evt: string, func: XmlListener) {
        this.addListener(evt, func);
    }

    public off(evt: string, func: XmlListener) {
        this.removeListener(evt, func);
    }

    private $addListener(evt: string, func: XmlListener) {
        if (!EVENT_NAME.test(evt)) {
            const path = evt.replace(/^<\/?|>$/g, '') || 'root.child';
            throw new TypeError(
                `Invalid event name ${JSON.stringify(evt)}: use '<${path}>' for an opening `
                + `element or '</${path}>' for a closing one, with the dotted path from the root`,
            );
        }
        const funcs = this.evtListeners[evt];
        if (funcs) {
            funcs.push(func);
        } else {
            this.evtListeners[evt] = [func];
        }
        // open-tag events look like `<path>`; close-tag events like `</path>`.
        if (evt.charCodeAt(1) !== SLASH) {
            this.openListenerCount++;
        }
        if (evt.charCodeAt(0) === LT) {
            const path = evt.slice(evt.charCodeAt(1) === SLASH ? 2 : 1, evt.length - 1);
            this.watchedPaths.add(path);
            const depth = segments(path);
            if (depth > this.pathDepth) {
                this.pathDepth = depth;
                this.retrack();
            }
            const dot = path.lastIndexOf('.');
            if (dot < 0) {
                this.watchedTopLevel.add(path);
            } else {
                const parent = path.slice(0, dot);
                let children = this.watchedChildren.get(parent);
                if (!children) {
                    children = new Set();
                    this.watchedChildren.set(parent, children);
                }
                children.add(path.slice(dot + 1));
            }
        }
    }

    private $removeListener(evt: string, func: XmlListener) {
        const funcs = this.evtListeners[evt];
        let idx = -1;
        if (funcs) {
            idx = funcs.indexOf(func);
        }
        if (idx < 0) {
            return;
        }
        funcs.splice(idx, 1);
        const close = evt.charCodeAt(1) === SLASH;
        if (!close) {
            this.openListenerCount--;
        }
        if (funcs.length > 0) {
            return;
        }
        delete this.evtListeners[evt];
        const path = evt.slice(close ? 2 : 1, evt.length - 1);
        if (this.evtListeners[close ? '<' + path + '>' : '</' + path + '>']) {
            return;
        }
        this.watchedPaths.delete(path);
        const dot = path.lastIndexOf('.');
        if (dot < 0) {
            this.watchedTopLevel.delete(path);
            return;
        }
        const parent = path.slice(0, dot);
        const children = this.watchedChildren.get(parent);
        if (children) {
            children.delete(path.slice(dot + 1));
            if (children.size === 0) {
                this.watchedChildren.delete(parent);
            }
        }
    }

    private emit(evt: string, node: XmlNode, parentNode?: XmlNode) {
        const funcs = this.evtListeners[evt];
        if (funcs) {
            for (let i = 0; i < funcs.length; i++) {
                funcs[i](node, parentNode);
            }
        }
    }
}
