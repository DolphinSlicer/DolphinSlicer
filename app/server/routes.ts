// The server side of the site: the Google sign-in token service (/api/auth, googleAuth.ts) and
// the MCP server for AI assistants (/mcp, mcp/). Cloudflare Pages Functions (functions/) and
// Vite's dev and preview servers (vitePlugin.ts) both hand requests here. Without the Google
// client secret neither is served.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { type AuthEnv, handleAuth } from './googleAuth';
import * as oauth from './mcp/oauth';
import type { Assets } from './mcp/profiles';
import { handleMcp } from './mcp/server';

export interface ServerEnv extends AuthEnv {
  ASSETS?: Assets;
}

const notFound = () => oauth.json({ error: 'not_found' }, 404);

/** The response for a server route, or null when the path is not one. */
export async function handleRequest(req: Request, env: ServerEnv): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const origin = url.origin;
  const isMcp = path === '/mcp' || path.startsWith('/mcp/') || path.startsWith('/.well-known/oauth-');
  if (!path.startsWith('/api/auth/') && !isMcp) return null;
  if (!env.GOOGLE_CLIENT_SECRET) return notFound();

  if (path.startsWith('/api/auth/')) {
    // Google returns MCP sign-ins to the same callback as the app's own.
    if (path === '/api/auth/callback' && url.searchParams.get('state')?.startsWith('mcp.')) return oauth.callback(env, req, origin);
    return handleAuth(req, env);
  }
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: oauth.CORS });
  switch (`${req.method} ${path}`) {
    case 'GET /.well-known/oauth-protected-resource':
    case 'GET /.well-known/oauth-protected-resource/mcp':
      return oauth.protectedResourceMetadata(origin);
    case 'GET /.well-known/oauth-authorization-server':
      return oauth.authorizationServerMetadata(origin);
    case 'POST /mcp/register':
      return oauth.register(env, req);
    case 'GET /mcp/authorize':
      return oauth.authorize(env, req, origin);
    case 'POST /mcp/authorize':
      return oauth.consent(env, req, origin);
    case 'POST /mcp/token':
      return oauth.token(env, req, origin);
  }
  if (path === '/mcp') return handleMcp(env, req, origin);
  return notFound();
}
