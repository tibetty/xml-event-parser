import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            reporter: ['text', 'lcov'],
            // The floor sits at today's coverage; raise it as tests land, never lower it.
            thresholds: {
                statements: 99,
                branches: 96,
                functions: 100,
                lines: 99,
            },
        },
    },
});
