import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

function sourceArchives(): Plugin {
  const middleware = (directory: string) => (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (!['/source/grava-simples-source.tar.gz', '/source/obs-wasm-source.tar.gz', '/source/ffmpeg-export-source.tar.gz'].includes(path)) return next();
    const file = resolve(directory, path.slice(1));
    if (!existsSync(file)) return next();
    // These are downloadable gzip archives, not precompressed HTTP responses.
    // Static middleware would otherwise attach Content-Encoding: gzip and make
    // browsers transparently decompress the archive while keeping its .gz name.
    response.setHeader('Content-Type', 'application/gzip');
    response.setHeader('Content-Disposition', `attachment; filename="${path.split('/').at(-1)}"`);
    response.setHeader('Content-Length', statSync(file).size);
    response.setHeader('Cache-Control', 'no-cache');
    if (request.method === 'HEAD') return response.end();
    createReadStream(file).pipe(response);
  };
  return {
    name: 'corresponding-source-downloads',
    configureServer(server) { server.middlewares.use(middleware(resolve('public'))); },
    configurePreviewServer(server) { server.middlewares.use(middleware(resolve('dist'))); },
  };
}

export default defineConfig({
  plugins: [sourceArchives(), react()],
  server: { host: '0.0.0.0', port: 5173, strictPort: true, allowedHosts: true, headers },
  preview: { host: '0.0.0.0', port: 5173, strictPort: true, allowedHosts: true, headers },
  build: { target: 'es2022' },
});
