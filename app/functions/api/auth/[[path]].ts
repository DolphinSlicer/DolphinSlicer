// Cloudflare Pages Function: the Google sign-in token service (server/googleAuth.ts), and the
// MCP server's sign-in callback. Set the GOOGLE_CLIENT_SECRET secret in the Pages project;
// without it the app uses the popup-only sign-in (an hour at a time).
// SPDX-License-Identifier: AGPL-3.0-or-later
import { pagesHandler } from '../../../server/pages';

export const onRequest = pagesHandler;
