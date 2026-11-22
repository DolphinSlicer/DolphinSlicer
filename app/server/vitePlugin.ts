// The token service (server/googleAuth.ts) in Vite's dev and preview servers, as on Cloudflare
// Pages. The client secret comes from GOOGLE_CLIENT_SECRET in the environment or in .dev.vars
// (Wrangler's file for local secrets; gitignored). Without it /api/auth is not served and the
// app uses the popup-only sign-in.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { type AuthEnv, handleAuth } from './googleAuth';

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

export function authService(root: string): Plugin {
  const vars = devVars(`${root}/.dev.vars`);
  const env: AuthEnv = {
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ?? vars.GOOGLE_CLIENT_SECRET,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? vars.GOOGLE_CLIENT_ID,
  };
  const middleware = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!env.GOOGLE_CLIENT_SECRET || !req.url?.startsWith('/api/auth/')) return next();
    try {
      // Behind a TLS-terminating proxy the public origin is https.
      const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost';
      const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(String(host));
      const proto = req.headers['x-forwarded-proto'] ?? (local ? 'http' : 'https');
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const r = await handleAuth(new Request(`${proto}://${host}${req.url}`, { method: req.method, headers }), env);
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
    name: 'dolphin-auth-service',
    configureServer: (s) => {
      s.middlewares.use(middleware);
    },
    configurePreviewServer: (s) => {
      s.middlewares.use(middleware);
    },
  };
}
