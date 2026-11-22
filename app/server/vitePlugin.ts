// The server routes (server/routes.ts: the sign-in token service and the MCP server) in Vite's
// dev and preview servers, as on Cloudflare Pages. The client secret comes from
// GOOGLE_CLIENT_SECRET in the environment or in .dev.vars (Wrangler's file for local secrets;
// gitignored). Without it they are not served and the app uses the popup-only sign-in.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, normalize } from 'node:path';
import type { Plugin } from 'vite';
import type { Assets } from './mcp/profiles';
import { handleRequest, type ServerEnv } from './routes';

function devVars(file: string): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/.exec(line);
      if (m) out[m[1]!] = m[2]!;
    }
    return out;
  } catch {
    return {};
  }
}

/** The site's static files on disk (public/ in dev, dist/ in preview), as Cloudflare's ASSETS binding serves them. */
function filesIn(dir: string): Assets {
  return {
    async fetch(path: string) {
      const file = normalize(join(dir, decodeURIComponent(new URL(path, 'http://x').pathname)));
      if (!file.startsWith(dir)) return new Response(null, { status: 404 });
      try {
        return new Response(await readFile(file));
      } catch {
        return new Response(null, { status: 404 });
      }
    },
  };
}

export function authService(root: string): Plugin {
  const vars = devVars(`${root}/.dev.vars`);
  const base: ServerEnv = {
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ?? vars.GOOGLE_CLIENT_SECRET,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? vars.GOOGLE_CLIENT_ID,
  };
  const middleware = (env: ServerEnv) => async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const path = req.url?.split('?')[0] ?? '';
    if (!env.GOOGLE_CLIENT_SECRET || !/^\/(api\/auth\/|mcp(\/|$)|\.well-known\/oauth-)/.test(path)) return next();
    try {
      // Behind a TLS-terminating proxy the public origin is https.
      const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost';
      const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(String(host));
      const proto = req.headers['x-forwarded-proto'] ?? (local ? 'http' : 'https');
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks);
      const r = await handleRequest(new Request(`${proto}://${host}${req.url}`, { method: req.method, headers, body }), env);
      if (!r) return next();
      res.statusCode = r.status;
      r.headers.forEach((v, k) => {
        if (k !== 'set-cookie') res.setHeader(k, v);
      });
      const cookies = r.headers.getSetCookie();
      if (cookies.length) res.setHeader('Set-Cookie', cookies);
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      res.statusCode = 500;
      res.end(String(e));
    }
  };
  return {
    name: 'dolphin-server-routes',
    configureServer: (s) => {
      s.middlewares.use(middleware({ ...base, ASSETS: filesIn(join(root, 'public')) }));
    },
    configurePreviewServer: (s) => {
      s.middlewares.use(middleware({ ...base, ASSETS: filesIn(join(root, s.config.build.outDir)) }));
    },
  };
}
