// The server routes (routes.ts) as a Cloudflare Pages Function. The site's static files come
// from the ASSETS binding.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { handleRequest } from './routes';

interface PagesContext {
  request: Request;
  env: { GOOGLE_CLIENT_SECRET?: string; GOOGLE_CLIENT_ID?: string; ASSETS: { fetch(req: Request | string): Promise<Response> } };
  next(): Promise<Response>;
}

export async function pagesHandler(ctx: PagesContext): Promise<Response> {
  const { request, env } = ctx;
  const origin = new URL(request.url).origin;
  const assets = { fetch: (path: string) => env.ASSETS.fetch(new Request(new URL(path, origin))) };
  return (await handleRequest(request, { ...env, ASSETS: assets })) ?? ctx.next();
}
