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
        input: 'src/index.ts',
        output: { dir: 'dist', format: 'esm' as const },
        plugins: [dts({ emitDtsOnly: true })],
    },
]);
