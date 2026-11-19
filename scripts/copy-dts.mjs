// rolldown-plugin-dts writes one ESM declaration file per entry. CommonJS
// consumers need a .d.cts beside it, or TypeScript reads the CJS build's types
// as ESM ("masquerading as ESM"). The declarations are self-contained, so the
// same text serves both module systems.
import { copyFileSync, renameSync } from 'node:fs';

for (const entry of ['index', 'stream']) {
    copyFileSync(`dist/${entry}.d.ts`, `dist/${entry}.d.cts`);
    renameSync(`dist/${entry}.d.ts`, `dist/${entry}.d.mts`);
}
