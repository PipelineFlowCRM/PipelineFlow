import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
var REPO_ROOT = path.resolve(__dirname, '../..');
// Single source of truth for cross-app env values like `MAPBOX_API_TOKEN`
// lives in the monorepo root .env. Vite's default `envDir` is the package
// root, so we explicitly redirect it. process.env still wins (so a
// docker-compose build-arg or shell export overrides the root .env file).
export default defineConfig(function (_a) {
    var _b, _c, _d, _e;
    var mode = _a.mode;
    var rootEnv = loadEnv(mode, REPO_ROOT, ['VITE_', 'MAPBOX_']);
    var proxyTarget = (_c = (_b = process.env.VITE_API_URL) !== null && _b !== void 0 ? _b : rootEnv.VITE_API_URL) !== null && _c !== void 0 ? _c : 'http://localhost:4000';
    return {
        plugins: [react()],
        envDir: REPO_ROOT,
        // Expose `MAPBOX_API_TOKEN` (and any future MAPBOX_* keys) to the client
        // bundle alongside the default `VITE_*` prefix. Without this, Vite would
        // strip non-VITE_ vars from `import.meta.env` even when present in the
        // .env file. NOTE: this prefix is broad — DO NOT introduce a server-only
        // secret named `MAPBOX_…` in root .env, it would leak into the bundle.
        envPrefix: ['VITE_', 'MAPBOX_'],
        resolve: {
            alias: {
                '@': path.resolve(__dirname, './src'),
            },
        },
        server: {
            port: 5173,
            proxy: {
                '/api': {
                    target: proxyTarget,
                    changeOrigin: true,
                },
                '/admin/queues': {
                    target: proxyTarget,
                    changeOrigin: true,
                },
            },
        },
        define: {
            // Belt-and-suspenders: in the Docker build the root .env isn't in the
            // build context, so envDir alone wouldn't pick the token up. Reading
            // from process.env (populated via the Dockerfile ARG/ENV) backs the
            // .env file as the second source of truth.
            'import.meta.env.MAPBOX_API_TOKEN': JSON.stringify((_e = (_d = process.env.MAPBOX_API_TOKEN) !== null && _d !== void 0 ? _d : rootEnv.MAPBOX_API_TOKEN) !== null && _e !== void 0 ? _e : ''),
        },
    };
});
