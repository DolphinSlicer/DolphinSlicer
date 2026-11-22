// Cloudflare Pages Function: the MCP server for AI assistants (server/mcp/).
// SPDX-License-Identifier: AGPL-3.0-or-later
import { pagesHandler } from '../../server/pages';

export const onRequest = pagesHandler;
