import type { Plugin } from 'vite';
import { loadEnv } from 'vite';
import { createHotmartRuntime, handleHotmart, MAX_HOTMART_BODY_BYTES } from './controller.ts';

/** Same authenticated handler locally and on Vercel; no development login bypass. */
export function hotmartApi(): Plugin {
  return {
    name: 'hotmart-publishing-api',
    configureServer(server) {
      const env = { ...process.env, ...loadEnv(server.config.mode, server.config.envDir, '') };
      const deps = createHotmartRuntime(env);
      server.middlewares.use(async (incoming, outgoing, next) => {
        const url = new URL(incoming.url || '/', 'http://localhost');
        if (url.pathname !== '/api/hotmart') return next();
        try {
          const chunks: Buffer[] = []; let size = 0;
          for await (const chunk of incoming) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.byteLength;
            if (size > MAX_HOTMART_BODY_BYTES) {
              outgoing.writeHead(413, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
              outgoing.end(JSON.stringify({ error: 'Os dados enviados excedem o limite.' })); return;
            }
            chunks.push(bytes);
          }
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(',') : value);
          const method = incoming.method || 'GET';
          const response = await handleHotmart(new Request(url, { method, headers, ...(['GET', 'HEAD'].includes(method) ? {} : { body: Buffer.concat(chunks).toString('utf8') }) }), deps);
          for (const [name, value] of response.headers) if (name !== 'set-cookie') outgoing.setHeader(name, value);
          const cookies = response.headers.getSetCookie();
          if (cookies.length) outgoing.setHeader('Set-Cookie', cookies);
          outgoing.writeHead(response.status); outgoing.end(await response.text());
        } catch {
          if (!outgoing.headersSent) outgoing.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          outgoing.end(JSON.stringify({ error: 'A conexão com a Hotmart está indisponível.' }));
        }
      });
    },
  };
}
