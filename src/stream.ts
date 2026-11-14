import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
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
 * Chunks may split anywhere; multibyte characters split across chunk boundaries
 * are reassembled with `StringDecoder`. Backpressure is applied per chunk: the
 * stream stops pulling input while the readable side is full, so a slow consumer
 * does not accumulate the document.
 *
 * This module imports `node:stream`, which is why it is a separate entry point
 * (`xml-event-parser/stream`): the core parser stays usable in browsers and edge
 * runtimes that expose no Node built-ins.
 */
export function createStream(options: XmlStreamOptions): Transform {
    const event = toEventPath(options && options.event);
    const parser = new XmlParser({ ...options, progressive: true, retain: 'none', keep: [event] });
    const decoder = new StringDecoder('utf8');

    const stream = new Transform({
        readableObjectMode: true,
        transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
            try {
                parser.write(typeof chunk === 'string' ? chunk : decoder.write(chunk));
                callback();
            } catch (error) {
                callback(error as Error);
            }
        },
        flush(callback: (error?: Error | null) => void) {
            try {
                const tail = decoder.end();
                if (tail.length > 0) {
                    parser.write(tail);
                }
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
