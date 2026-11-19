import { Transform } from 'node:stream';
import { XmlParser } from './xmlparser';
import type { XmlParserOptions } from './xmlparser';

export interface XmlStreamOptions extends XmlParserOptions {
    /**
     * Close-event path to emit, in event form: `'</testsuites.testsuite.testcase>'`.
     *
     * Required, and it is what keeps memory bounded: elements matching the path
     * are handed out whole (with their children) and everything else is
     * dropped as it closes. Memory is the largest matched element, not the file.
     */
    event: string;
}

/** Accept both the event form (`'</a.b>'`) and the bare path (`'a.b'`). */
function toEventPath(event: unknown): string {
    if (typeof event !== 'string' || event.length === 0) {
        throw new TypeError('createStream() requires { event }, e.g. { event: "</root.item>" }');
    }
    return event.charCodeAt(0) === 60 /* '<' */ ? event : '</' + event + '>';
}

/** Bytes held back to find the XML declaration's `?>` before giving up on it. */
const DETECT_LIMIT = 1024;

/**
 * Pick the encoding of a document from its first bytes (XML 1.0 Appendix F): a
 * byte-order mark wins, then a UTF-16 `<?` pattern, then the `encoding` of an
 * ASCII-compatible XML declaration, then UTF-8. Returns `null` while `head`
 * is too short to decide and more input may follow.
 */
function detectEncoding(head: Buffer, final: boolean): string | null {
    if (head.length < 4 && !final) {
        return null; // every signature below fits in four bytes
    }
    const b0 = head[0];
    const b1 = head[1];
    if (head.length >= 2) {
        if (b0 === 0xff && b1 === 0xfe) {
            return 'utf-16le';
        }
        if (b0 === 0xfe && b1 === 0xff) {
            return 'utf-16be';
        }
    }
    if (head.length >= 3 && b0 === 0xef && b1 === 0xbb && head[2] === 0xbf) {
        return 'utf-8';
    }
    if (head.length >= 4) {
        if (b0 === 0x3c && b1 === 0x00 && head[2] === 0x3f && head[3] === 0x00) {
            return 'utf-16le';
        }
        if (b0 === 0x00 && b1 === 0x3c && head[2] === 0x00 && head[3] === 0x3f) {
            return 'utf-16be';
        }
    }
    const prefix = head.toString('latin1', 0, Math.min(head.length, 5));
    if (!'<?xml'.startsWith(prefix)) {
        return 'utf-8';
    }
    const end = head.indexOf('?>');
    if (end < 0) {
        return final || head.length >= DETECT_LIMIT ? 'utf-8' : null;
    }
    const declaration = head.toString('latin1', 0, end);
    const match = /\sencoding\s*=\s*(["'])([A-Za-z][A-Za-z0-9._-]*)\1/.exec(declaration);
    return match ? match[2] : 'utf-8';
}

/**
 * Parse XML from a readable stream, emitting one object per matching element.
 *
 * ```js
 * import { createStream } from 'xml-event-parser/stream';
 *
 * pipeline(
 *     createReadStream('junit.xml'),
 *     createStream({ event: '</testsuites.testsuite.testcase>' }),
 *     new Writable({ objectMode: true, write(testcase, _enc, done) { ...; done(); } }),
 * );
 * ```
 *
 * Byte input is decoded by the encoding the document declares (XML 1.0
 * Appendix F): a byte-order mark for UTF-8 or UTF-16, else the `encoding` of
 * the XML declaration, else UTF-8. Any encoding `TextDecoder` supports works;
 * an unsupported one fails the stream. Per the WHATWG Encoding Standard,
 * `ISO-8859-1` decodes as `windows-1252`. String chunks are taken as already
 * decoded.
 *
 * Chunks may split anywhere, including inside a multibyte character.
 * Backpressure is applied per chunk: the stream stops pulling input while the
 * readable side is full, so a slow consumer does not accumulate the document.
 *
 * This module imports `node:stream`, which is why it is a separate entry point
 * (`xml-event-parser/stream`): the core parser stays usable in browsers and edge
 * runtimes that expose no Node built-ins.
 */
export function createStream(options: XmlStreamOptions): Transform {
    const event = toEventPath(options && options.event);
    const parser = new XmlParser({ ...options, progressive: true, retain: 'none', keep: [event] });
    let decoder: TextDecoder | undefined;
    let head: Buffer | undefined;

    /** Decode `bytes`, holding them back until the encoding is known. */
    const decode = (bytes: Buffer, final: boolean): string => {
        if (!decoder) {
            head = head ? Buffer.concat([head, bytes]) : bytes;
            const encoding = detectEncoding(head, final);
            if (encoding === null) {
                return '';
            }
            try {
                decoder = new TextDecoder(encoding);
            } catch {
                throw new Error(`xml-event-parser: unsupported encoding ${JSON.stringify(encoding)}`);
            }
            bytes = head;
            head = undefined;
        }
        return decoder.decode(bytes, { stream: !final });
    };

    const stream = new Transform({
        readableObjectMode: true,
        transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
            try {
                parser.write(typeof chunk === 'string' ? chunk : decode(chunk, false));
                callback();
            } catch (error) {
                callback(error as Error);
            }
        },
        flush(callback: (error?: Error | null) => void) {
            try {
                parser.write(decode(Buffer.alloc(0), true));
                parser.end();
                callback();
            } catch (error) {
                callback(error as Error);
            }
        },
    });

    parser.on(event, (node) => {
        stream.push(node);
    });

    return stream;
}
