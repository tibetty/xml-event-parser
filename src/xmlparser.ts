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

const XML_ENTITY = /&(#[xX][0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g;

/**
 * Decode the XML entities that occur in OSM data. The cheap `indexOf` check
 * keeps the common case (no entities) allocation-free.
 */
export function decodeEntities(value: string): string {
    if (value.indexOf('&') < 0) {
        return value;
    }
    return value.replace(XML_ENTITY, (match, entity: string) => {
        switch (entity) {
            case 'amp': return '&';
            case 'lt': return '<';
            case 'gt': return '>';
            case 'quot': return '"';
            case 'apos': return "'";
        }
        if (entity.charCodeAt(0) === 35) { // '#'
            const hex = entity.charCodeAt(1) === 120 || entity.charCodeAt(1) === 88; // 'x' or 'X'
            const code = hex ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
            if (Number.isFinite(code) && code >= 0 && code <= 0x10FFFF) {
                return String.fromCodePoint(code);
            }
        }
        return match;
    });
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
}

export class XmlParser {
    private queryParent: boolean = false;
    private progressive: boolean = false;
    private parentMap: WeakMap<any, any> = new WeakMap();
    private evtListeners: { [k: string]: any };
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

    constructor(opts: any) {
        if (opts) {
            this.queryParent = opts.queryParent ? true : false;
            this.progressive = opts.progressive;
            if (this.queryParent) {
                this.parentMap = new WeakMap();
            }
        }
        this.evtListeners = {};
    }

    /**
     * Scan an XML string in a single pass, maintaining a stack of open elements,
     * building a `tagName`/attribute/`children` node tree and emitting
     * progressive `<path>` / `</path>` events as elements open and close.
     *
     * @param xml - the XML source to scan.
     * @param parent - optional pre-existing node that owns the parsed content;
     * when supplied, top-level nodes attach to its `children` instead of being
     * returned as roots.
     * @param dir - optional dotted tag-path prefix applied to emitted event names.
     * @returns the top-level nodes (empty when a `parent` owns them).
     */
    public parse(xml: string, parent?: any, dir?: string) {
        const len = xml.length;
        const progressive = this.progressive;
        const queryParent = this.queryParent;
        const parentMap = this.parentMap;

        const basePath = dir ? dir : '';
        const roots: any[] = [];
        const stack: Frame[] = [];
        const hasOpenListeners = progressive && this.openListenerCount > 0;
        let top: Frame | undefined = parent
            ? { node: parent, fullTag: basePath, textStart: 0 }
            : undefined;
        const rootOwner = top;

        let i = 0;
        while (i < len) {
            const lt = xml.indexOf('<', i);
            if (lt < 0) {
                break;
            }
            i = lt + 1;
            const c = xml.charCodeAt(i);

            if (c === SLASH) {
                // closing tag: </tag>
                const gt = xml.indexOf('>', i);
                if (gt < 0) {
                    break;
                }
                const frame = stack.pop();
                i = gt + 1;
                if (!frame) {
                    continue;
                }
                const node = frame.node;
                const parentFrame = stack.length ? stack[stack.length - 1] : rootOwner;
                const parentNode = parentFrame ? parentFrame.node : undefined;

                if (!node.children && lt > frame.textStart) {
                    node.text = decodeContent(xml.slice(frame.textStart, lt));
                }

                if (progressive && this.watchedPaths.has(frame.fullTag)) {
                    this.emit('</' + frame.fullTag + '>', node, parentNode);
                }

                if (parentNode) {
                    const inner = parentNode.children;
                    if (inner) {
                        inner.push(node);
                    } else {
                        parentNode.children = [node];
                    }
                } else {
                    roots.push(node);
                }
                top = parentFrame;
                continue;
            }

            if (c === QUESTION) {
                // processing instruction: <? ... ?>
                const gt = xml.indexOf('>', i);
                i = gt < 0 ? len : gt + 1;
                continue;
            }

            if (c === BANG) {
                // comment, CDATA or doctype
                if (xml.charCodeAt(i + 1) === 45 && xml.charCodeAt(i + 2) === 45) {
                    const end = xml.indexOf('-->', i + 3);
                    i = end < 0 ? len : end + 3;
                } else if (xml.startsWith('![CDATA[', i)) {
                    // CDATA is content, not markup: skip to its terminator so
                    // '<' and '>' inside it are not read as elements. The
                    // closing-tag branch turns the slice into text, and
                    // decodeContent() keeps it verbatim.
                    const end = xml.indexOf(']]>', i + 9);
                    i = end < 0 ? len : end + 3;
                } else {
                    const gt = xml.indexOf('>', i);
                    i = gt < 0 ? len : gt + 1;
                }
                continue;
            }

            // opening tag: read the tag name
            let j = i;
            while (j < len) {
                const ch = xml.charCodeAt(j);
                if (isSpace(ch) || ch === SLASH || ch === GT) {
                    break;
                }
                j++;
            }
            const tag = xml.slice(i, j);
            const node: XmlNode = { tagName: tag };

            // parse attributes up to the closing '>' (quote-aware)
            let selfClose = false;
            while (j < len) {
                let ch = xml.charCodeAt(j);
                while (isSpace(ch)) {
                    ch = xml.charCodeAt(++j);
                }
                if (ch === GT) {
                    j++;
                    break;
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
                const attrName = xml.slice(nameStart, j);

                while (isSpace(xml.charCodeAt(j))) {
                    j++;
                }
                if (xml.charCodeAt(j) === EQUALS) {
                    j++;
                    while (isSpace(xml.charCodeAt(j))) {
                        j++;
                    }
                    const q = xml.charCodeAt(j);
                    if (q === DQUOTE || q === SQUOTE) {
                        j++;
                        let valEnd = xml.indexOf(q === DQUOTE ? '"' : "'", j);
                        if (valEnd < 0) {
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
            i = j;

            const parentNode = top ? top.node : undefined;

            if (queryParent && parentNode) {
                parentMap.set(node, parentNode);
            }

            // '?'/'!' prefixed tags were already routed above; treat trailing
            // '/' (and the implicitly self-closing prolog tags) as leaves.
            if (selfClose) {
                if (progressive) {
                    const parentTag = top ? top.fullTag : basePath;
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
                if (parentNode) {
                    const inner = parentNode.children;
                    if (inner) {
                        inner.push(node);
                    } else {
                        parentNode.children = [node];
                    }
                } else {
                    roots.push(node);
                }
                continue;
            }

            const fullTag = top
                ? (top.fullTag ? top.fullTag + '.' + tag : tag)
                : (basePath ? basePath + '.' + tag : tag);
            if (hasOpenListeners && this.watchedPaths.has(fullTag)) {
                this.emit('<' + fullTag + '>', node, parentNode);
            }
            const frame: Frame = { node, fullTag, textStart: i };
            stack.push(frame);
            top = frame;
        }

        // Truncated input (a download cut mid-document, an unterminated CDATA
        // section, a missing close tag): close the open elements instead of
        // dropping everything parsed so far. Any trailing text belongs to the
        // innermost element that is being closed here.
        let trailing = xml.length;
        while (stack.length > 0) {
            const frame = stack.pop()!;
            const node = frame.node;
            if (!node.children && trailing > frame.textStart) {
                node.text = decodeContent(xml.slice(frame.textStart, trailing));
                trailing = frame.textStart;
            }
            const parentFrame = stack.length ? stack[stack.length - 1] : rootOwner;
            const parentNode = parentFrame ? parentFrame.node : undefined;
            if (parentNode) {
                if (parentNode.children) {
                    parentNode.children.push(node);
                } else {
                    parentNode.children = [node];
                }
            } else {
                roots.push(node);
            }
        }

        return roots;
    }

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
