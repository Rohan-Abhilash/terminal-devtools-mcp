import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['esm'],
    target: 'node18',
    platform: 'node',
    clean: true,
    sourcemap: true,
    dts: false,
    splitting: false,
    shims: true,
    // The #!/usr/bin/env node line on the entrypoint
    banner: { js: '#!/usr/bin/env node' },
    // Keep node-pty & xterm external: node-pty has a native binding that
    // shouldn't be bundled, and xterm's headless build is fine at runtime.
    external: [
        '@homebridge/node-pty-prebuilt-multiarch',
        '@xterm/headless',
    ],
});
