import { defineConfig } from 'rolldown';
import { dts } from 'rolldown-plugin-dts';

/** One module, published as ESM and CommonJS with types. */
export default defineConfig([
    {
        input: 'src/index.ts',
        output: [
            { file: 'dist/index.mjs', format: 'esm' as const, minify: true },
            { file: 'dist/index.cjs', format: 'cjs' as const, exports: 'named' as const, minify: true },
        ],
    },
    {
        // Node-only adapter, kept out of the core entry so browsers and edge
        // runtimes never see a node: import.
        input: 'src/stream.ts',
        external: [/^node:/],
        output: [
            { file: 'dist/stream.mjs', format: 'esm' as const, minify: true },
            { file: 'dist/stream.cjs', format: 'cjs' as const, exports: 'named' as const, minify: true },
        ],
    },
    {
        input: 'src/index.ts',
        output: { dir: 'dist', format: 'esm' as const },
        plugins: [dts({ emitDtsOnly: true })],
    },
    {
        input: 'src/stream.ts',
        output: { dir: 'dist', format: 'esm' as const },
        plugins: [dts({ emitDtsOnly: true })],
    },
]);
