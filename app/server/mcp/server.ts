// The MCP endpoint (POST /mcp, Streamable HTTP, JSON responses, no sessions). Serves both
// protocol eras: the current one (2026-07-28: no handshake, each request names its version in
// _meta, server/discover) and the earlier one (initialize first) that many clients still use.
// Every request needs an access token from the sign-in (oauth.ts).
// SPDX-License-Identifier: AGPL-3.0-or-later
import { AuthExpired } from '../../src/drive/api';
import { accessToken, CORS, json, MCP_SCOPE, type OAuthEnv, resourceMetadataUrl } from './oauth';
import { type Assets, Profiles } from './profiles';
import { TOOLS, ToolError } from './tools';
import { UserData } from './userData';

export interface McpEnv extends OAuthEnv {
  ASSETS?: Assets;
}

const CURRENT = '2026-07-28';
const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26'];
const META = 'io.modelcontextprotocol/';
const SERVER_INFO = {
  name: 'dolphinslicer',
  title: 'DolphinSlicer',
  version: '1.0.0',
  description: 'Your DolphinSlicer presets and OrcaSlicer profiles',
  websiteUrl: 'https://dolphinslicer.app',
};
const INSTRUCTIONS =
  "DolphinSlicer is OrcaSlicer in the browser. These tools read the user's setup and presets (as DolphinSlicer last synced them to their Google Drive), OrcaSlicer's system profiles and setting help, and save presets. Start with get_setup. Saved presets reach DolphinSlicer at its next sync, when its tab is reopened or reloaded. Ask before saving.";

type Id = string | number;
interface RpcRequest {
  jsonrpc: '2.0';
  id?: Id;
  method: string;
  params?: Record<string, unknown> & { _meta?: Record<string, unknown> };
}

const rpcError = (id: Id | null, code: number, message: string, status = 200, data?: unknown) =>
  json({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } }, status);

/** A header value, decoded when sent as "=?base64?…?=" (values that are not plain ASCII). */
function header(req: Request, name: string): string | null {
  const v = req.headers.get(name);
  const m = v && /^=\?base64\?(.*)\?=$/.exec(v);
  if (!m) return v;
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(m[1]!), (c) => c.charCodeAt(0)));
  } catch {
    return v;
  }
}

function challenge(origin: string, invalid: boolean) {
  const params = [`resource_metadata="${resourceMetadataUrl(origin)}"`, `scope="${MCP_SCOPE}"`];
  if (invalid) params.unshift('error="invalid_token"');
  return json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': `Bearer ${params.join(', ')}` });
}

const toolList = () =>
  TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations }));

async function callTool(params: RpcRequest['params'], ctx: () => { profiles: Profiles; user: UserData }) {
  const name = params?.name;
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { unknown: String(name) };
  const args = (params?.arguments ?? {}) as Record<string, unknown>;
  try {
    const out = await tool.run(args && typeof args === 'object' ? args : {}, ctx());
    return { result: { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out, isError: false } };
  } catch (e) {
    if (e instanceof AuthExpired) throw e;
    const message = e instanceof ToolError ? e.message : `Something went wrong: ${(e as Error).message}`;
    return { result: { content: [{ type: 'text', text: message }], isError: true } };
  }
}

export async function handleMcp(env: McpEnv, req: Request, origin: string): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  // No sessions and no server-sent stream.
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
  const token = await accessToken(env, req, origin);
  if (!token) return challenge(origin, !!req.headers.get('authorization'));
  if (!env.ASSETS) return json({ error: 'not_configured' }, 500);

  let msg: RpcRequest;
  try {
    msg = (await req.json()) as RpcRequest;
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string')
    return rpcError(null, -32600, 'Invalid request', 400);
  // Notifications (initialized, cancelled, …) need no answer.
  if (msg.id === undefined) return new Response(null, { status: 202, headers: CORS });
  const id = msg.id;
  const assets = env.ASSETS;
  const ctx = () => ({ profiles: new Profiles(assets), user: new UserData(token.gat) });

  try {
    const version = msg.params?._meta?.[`${META}protocolVersion`];
    if (typeof version === 'string') {
      // The current era: every request names its version, and its headers repeat the request.
      if (version !== CURRENT)
        return rpcError(id, -32022, 'Unsupported protocol version', 400, { supported: [CURRENT, ...LEGACY], requested: version });
      if (header(req, 'mcp-protocol-version') !== version || header(req, 'mcp-method') !== msg.method)
        return rpcError(id, -32020, 'Headers do not match the request', 400);
      if (msg.method === 'tools/call' && header(req, 'mcp-name') !== msg.params?.name)
        return rpcError(id, -32020, 'Headers do not match the request', 400);
      const ok = (result: object) =>
        json({ jsonrpc: '2.0', id, result: { resultType: 'complete', ...result, _meta: { [`${META}serverInfo`]: SERVER_INFO } } });
      switch (msg.method) {
        case 'server/discover':
          return ok({
            supportedVersions: [CURRENT, ...LEGACY],
            capabilities: { tools: {} },
            instructions: INSTRUCTIONS,
            ttlMs: 3600_000,
            cacheScope: 'public',
          });
        case 'tools/list':
          return ok({ tools: toolList(), ttlMs: 3600_000, cacheScope: 'public' });
        case 'tools/call': {
          const r = await callTool(msg.params, ctx);
          return r.result ? ok(r.result) : rpcError(id, -32602, `Unknown tool: ${r.unknown}`);
        }
        default:
          return rpcError(id, -32601, 'Method not found', 404);
      }
    }

    // The earlier era: initialize, then requests without _meta.
    const ok = (result: object) => json({ jsonrpc: '2.0', id, result });
    const asked = header(req, 'mcp-protocol-version');
    if (asked && msg.method !== 'initialize' && !LEGACY.includes(asked))
      return rpcError(id, -32600, `Unsupported protocol version ${asked}`, 400, { supported: [CURRENT, ...LEGACY] });
    switch (msg.method) {
      case 'initialize': {
        const v = msg.params?.protocolVersion;
        return ok({
          protocolVersion: typeof v === 'string' && LEGACY.includes(v) ? v : LEGACY[0],
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: toolList() });
      case 'tools/call': {
        const r = await callTool(msg.params, ctx);
        return r.result ? ok(r.result) : rpcError(id, -32602, `Unknown tool: ${r.unknown}`);
      }
      default:
        return rpcError(id, -32601, 'Method not found');
    }
  } catch (e) {
    // Google no longer accepts the token (revoked): sign in again.
    if (e instanceof AuthExpired) return challenge(origin, true);
    return rpcError(id, -32603, 'Internal error');
  }
}
