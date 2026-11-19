import sax from 'sax';

/**
 * The tree `sax` (strict mode) sees, in this library's node shape: attributes
 * flat on the node, `text` only on elements without child elements, comments
 * and processing instructions dropped. Used as the oracle for the differential
 * and conformance tests.
 */
export function saxTree(xml: string, mapAttribute: (value: string) => string = (value) => value): any[] {
    const parser = sax.parser(true);
    const roots: any[] = [];
    const stack: { node: any; text: string; hasChild: boolean }[] = [];
    parser.onopentag = (tag: any) => {
        const node: any = { tagName: tag.name };
        for (const [name, value] of Object.entries(tag.attributes)) {
            node[name] = mapAttribute(String(value));
        }
        const parent = stack[stack.length - 1];
        if (parent) {
            parent.hasChild = true;
            (parent.node.children ??= []).push(node);
        } else {
            roots.push(node);
        }
        stack.push({ node, text: '', hasChild: false });
    };
    const addText = (text: string) => {
        const top = stack[stack.length - 1];
        if (top) {
            top.text += text;
        }
    };
    parser.ontext = addText;
    parser.oncdata = addText;
    parser.onclosetag = () => {
        const frame = stack.pop()!;
        if (!frame.hasChild && frame.text) {
            frame.node.text = frame.text;
        }
    };
    parser.onerror = (error: Error) => {
        throw error;
    };
    parser.write(xml).close();
    return roots;
}
