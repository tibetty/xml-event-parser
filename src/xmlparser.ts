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

/** Decode one entity name (between `&` and `;`), or `null` if it is not one. */
function decodeEntity(name: string): string | null {
    switch (name) {
        case 'amp': return '&';
        case 'lt': return '<';
        case 'gt': return '>';
        case 'quot': return '"';
        case 'apos': return "'";
    }
    if (name.charCodeAt(0) === 35) { // '#'
        const hex = name.charCodeAt(1) === 120 || name.charCodeAt(1) === 88; // 'x' or 'X'
        const code = hex ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        if (Number.isFinite(code) && code >= 0 && code <= 0x10FFFF) {
            return String.fromCodePoint(code);
        }
    }
    return null;
}

/**
 * Decode XML entities.
 *
 * A manual scan beats `String.replace` with a callback by ~2.5x on OSM-sized
 * attribute values: no regex, no match object and no per-entity closure. The
 * `indexOf` guard keeps entity-free values allocation-free, and unknown
 * entities are left exactly as written.
 */
export function decodeEntities(value: string): string {
    let at = value.indexOf('&');
    if (at < 0) {
        return value;
    }
    let out = value.slice(0, at);
    while (at < value.length) {
        const semi = value.indexOf(';', at + 1);
        if (semi < 0) {
            out += value.slice(at);
            break;
        }
        const decoded = decodeEntity(value.slice(at + 1, semi));
        out += decoded === null ? value.slice(at, semi + 1) : decoded;
        at = value.indexOf('&', semi + 1);
        if (at < 0) {
            out += value.slice(semi + 1);
            break;
        }
        out += value.slice(semi + 1, at);
    }
    return out;
}

/**
 * Decode element content: CDATA sections contribute their text verbatim (per
 * XML, entities inside CDATA are not references), everything else is
 * entity-decoded. The common case - no CDATA - is one `indexOf` and the
 * existing fast path.
 */
function decodeContent(raw: string): string {
    if (raw.indexOf('<![CDATA[') < 0) {
        return raw.indexOf('&') < 0 ? raw : decodeEntities(raw);
    }
    let out = '';
    let at = 0;
    while (at < raw.length) {
        const start = raw.indexOf('<![CDATA[', at);
        if (start < 0) {
            out += decodeEntities(raw.slice(at));
            break;
        }
        if (start > at) {
            out += decodeEntities(raw.slice(at, start));
        }
        const end = raw.indexOf(']]>', start + 9);
        if (end < 0) {
            out += raw.slice(start + 9);
            break;
        }
        out += raw.slice(start + 9, end);
        at = end + 3;
    }
    return out;
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

function isSpace(c: number): boolean {
    return c === SPACE || c === TAB || c === LF || c === CR;
}

interface Frame {
    node: XmlNode;
    fullTag: string;
    textStart: number;
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

    /** Input not consumed yet: pending text plus any construct split by a chunk. */
    private buffer: string = '';
    /** Next position to scan in `buffer`. */
    private cursor: number = 0;
    private stack: Frame[] = [];
    private roots: XmlNode[] = [];
    private top: Frame | undefined;
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
        this.top = parent ? { node: parent, fullTag: this.basePath, textStart: 0 } : undefined;
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
        this.active = false;
    }

    /**
     * Store a closed element according to the retention mode.
     *
     * `parentNode === undefined` means the element is top-level (a root), which
     * `retain: 'root'` drops after emitting it.
     */
    private attach(node: XmlNode, parentNode: XmlNode | undefined): void {
        if (this.retain === 'none') {
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
                // closing tag: </tag>
                const gt = xml.indexOf('>', i);
                if (gt < 0) {
                    if (!final) {
                        break;
                    }
                    i = len;
                    break;
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
                    node.text = decodeContent(xml.slice(frame.textStart, lt));
                }

                if (progressive && this.watchedPaths.has(frame.fullTag)) {
                    this.emit('</' + frame.fullTag + '>', node, parentNode);
                }

                this.attach(node, parentNode);
                if (parentFrame) {
                    parentFrame.hasChild = true;
                }
                this.top = parentFrame;
                continue;
            }

            if (c === QUESTION) {
                // processing instruction: <? ... ?>
                const gt = xml.indexOf('>', i);
                if (gt < 0) {
                    if (!final) {
                        break;
                    }
                    i = len;
                    break;
                }
                i = gt + 1;
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
            if (opened.selfClose) {
                if (progressive) {
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
                this.attach(node, parentNode);
                if (this.top) {
                    this.top.hasChild = true;
                }
                continue;
            }

            const fullTag = this.top
                ? (this.top.fullTag ? this.top.fullTag + '.' + tag : tag)
                : (this.basePath ? this.basePath + '.' + tag : tag);
            if (hasOpenListeners && this.watchedPaths.has(fullTag)) {
                this.emit('<' + fullTag + '>', node, parentNode);
            }
            const frame: Frame = { node, fullTag, textStart: i };
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
                    node[attrName] = raw.indexOf('&') < 0 ? raw : decodeEntities(raw);
                    j = valEnd + 1;
                }
            } else if (attrName) {
                node[attrName] = '';
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
                node.text = decodeContent(xml.slice(frame.textStart, trailing));
                trailing = frame.textStart;
            }
            const parentFrame = this.stack.length ? this.stack[this.stack.length - 1] : this.rootOwner;
            const parentNode = parentFrame ? parentFrame.node : undefined;
            this.attach(node, parentNode);
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
        if (idx >= 0) {
            funcs.splice(idx, 1);
            if (evt.charCodeAt(1) !== SLASH) {
                this.openListenerCount--;
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
