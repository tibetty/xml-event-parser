import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            reporter: ['text', 'lcov'],
            // The floor sits at today's coverage; raise it as tests land, never lower it.
            thresholds: {
                statements: 98,
                branches: 95,
                functions: 100,
                lines: 98,
            },
        },
    },
});
