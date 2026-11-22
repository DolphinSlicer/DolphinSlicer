// Cloudflare Pages Function: the Google sign-in token service (server/googleAuth.ts).
// Set the GOOGLE_CLIENT_SECRET secret in the Pages project; without it the app uses the
// popup-only sign-in (an hour at a time).
// SPDX-License-Identifier: AGPL-3.0-or-later
import { type AuthEnv, handleAuth } from '../../../server/googleAuth';

export const onRequest = (ctx: { request: Request; env: AuthEnv }) => handleAuth(ctx.request, ctx.env);
