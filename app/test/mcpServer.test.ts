// The MCP server (server/mcp/): sign-in against a fake Google, both protocol eras, and the tools
// against a fake Drive and a small set of profiles.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { s256 } from '../server/crypto';
import { GOOGLE_TOKEN } from '../server/googleAuth';
import { presetShard } from '../server/mcp/shard';
import { handleRequest, type ServerEnv } from '../server/routes';

const ORIGIN = 'https://dolphinslicer.test';
const REDIRECT = 'https://client.example/callback';
const CLIENT_DOC = 'https://client.example/oauth/metadata.json';

// ── profiles ─────────────────────────────────────────────────────────────────────────────────
const schema = {
  orca_version: '2.5.0',
  print: [
    'layer_height',
    'wall_loops',
    'sparse_infill_density',
    'sparse_infill_pattern',
    'inherits',
    'print_settings_id',
    'compatible_printers',
  ],
  filament: ['nozzle_temperature', 'filament_type', 'inherits', 'filament_settings_id', 'filament_flow_ratio'],
  printer: ['nozzle_diameter', 'machine_start_gcode', 'inherits', 'printer_settings_id'],
  options: {
    layer_height: {
      type: 'float',
      label: 'Layer height',
      full_label: '',
      default: '0.2',
      min: 0,
      sidetext: 'mm',
      category: 'Quality',
      mode: 'simple',
      tooltip: 'Slicing height for each layer.',
    },
    wall_loops: {
      type: 'int',
      label: 'Wall loops',
      full_label: '',
      default: '2',
      min: 0,
      max: 1000,
      sidetext: '',
      category: 'Strength',
      mode: 'simple',
      tooltip: 'Number of walls.',
    },
    sparse_infill_density: {
      type: 'percent',
      label: 'Sparse infill density',
      full_label: '',
      default: '20%',
      min: 0,
      max: 100,
      sidetext: '%',
      category: 'Strength',
      mode: 'simple',
      tooltip: 'Density of internal sparse infill.',
    },
    sparse_infill_pattern: {
      type: 'enum',
      label: 'Sparse infill pattern',
      full_label: '',
      default: 'grid',
      enum_values: ['grid', 'gyroid'],
      enum_labels: ['Grid', 'Gyroid'],
      sidetext: '',
      category: 'Strength',
      mode: 'simple',
      tooltip: 'Line pattern.',
    },
    inherits: { type: 'string', label: 'Inherits', full_label: '', default: '', sidetext: '', category: '', mode: 'advanced', tooltip: '' },
    print_settings_id: {
      type: 'string',
      label: '',
      full_label: '',
      default: '',
      sidetext: '',
      category: '',
      mode: 'advanced',
      tooltip: '',
    },
    filament_settings_id: {
      type: 'strings',
      label: '',
      full_label: '',
      default: '',
      sidetext: '',
      category: '',
      mode: 'advanced',
      tooltip: '',
    },
    printer_settings_id: {
      type: 'string',
      label: '',
      full_label: '',
      default: '',
      sidetext: '',
      category: '',
      mode: 'advanced',
      tooltip: '',
    },
    compatible_printers: {
      type: 'strings',
      label: 'Select printers',
      full_label: '',
      default: '',
      sidetext: '',
      category: '',
      mode: 'advanced',
      tooltip: '',
    },
    nozzle_temperature: {
      type: 'ints',
      label: 'Other layers',
      full_label: 'Nozzle temperature',
      default: '200',
      min: 0,
      max: 1500,
      sidetext: '℃',
      category: '',
      mode: 'simple',
      tooltip: 'Nozzle temperature after the first layer',
    },
    filament_type: {
      type: 'enum',
      label: 'Type',
      full_label: '',
      default: 'PLA',
      enum_values: ['PLA', 'PETG'],
      sidetext: '',
      category: '',
      mode: 'simple',
      tooltip: '',
    },
    filament_flow_ratio: {
      type: 'floats',
      nullable: true,
      label: 'Flow ratio',
      full_label: '',
      default: '1',
      sidetext: '',
      category: '',
      mode: 'simple',
      tooltip: '',
    },
    nozzle_diameter: {
      type: 'floats',
      label: 'Nozzle diameter',
      full_label: '',
      default: '0.4',
      sidetext: 'mm',
      category: '',
      mode: 'advanced',
      tooltip: '',
    },
    machine_start_gcode: {
      type: 'string',
      label: 'Start G-code',
      full_label: '',
      default: '',
      sidetext: '',
      category: '',
      mode: 'advanced',
      tooltip: '',
    },
  },
};
const defaults = {
  print: { layer_height: '0.2', wall_loops: '2', sparse_infill_density: '20%', sparse_infill_pattern: 'grid', compatible_printers: [] },
  filament: { nozzle_temperature: ['200'], filament_type: ['PLA'], filament_flow_ratio: ['1'] },
  printer: { nozzle_diameter: ['0.4'], machine_start_gcode: 'G28' },
};
const presetFiles: Record<string, Record<string, object>> = {
  Acme: {
    fdm_process_common: { type: 'process', name: 'fdm_process_common', instantiation: 'false', wall_loops: '3' },
    '0.20mm Standard @Acme': {
      type: 'process',
      name: '0.20mm Standard @Acme',
      inherits: 'fdm_process_common',
      instantiation: 'true',
      version: '1.2.3',
      sparse_infill_density: '15%',
    },
    '0.12mm Fine @Acme': {
      type: 'process',
      name: '0.12mm Fine @Acme',
      inherits: 'fdm_process_common',
      instantiation: 'true',
      layer_height: '0.12',
    },
    'Acme Cube 0.4 nozzle': { type: 'machine', name: 'Acme Cube 0.4 nozzle', instantiation: 'true', include: ['Acme template start'] },
    'Acme template start': { type: 'machine', name: 'Acme template start', instantiation: 'false', machine_start_gcode: 'G28\nM117 Acme' },
  },
  OrcaFilamentLibrary: {
    'Generic PLA @System': { type: 'filament', name: 'Generic PLA @System', instantiation: 'true', nozzle_temperature: ['210'] },
  },
};
const shards: Record<number, Record<string, Record<string, string>>> = {};
for (const [vendor, files] of Object.entries(presetFiles))
  for (const [name, j] of Object.entries(files)) ((shards[presetShard(name)] ??= {})[name] ??= {})[vendor] = JSON.stringify(j);
const assetFiles: Record<string, unknown> = {
  '/profiles-manifest.json': { base: 'profiles/h', library: 'OrcaFilamentLibrary', catalog: 'profiles/h/catalog.json', vendors: [] },
  '/profiles/h/catalog.json': {
    Acme: { printer: ['Acme Cube 0.4 nozzle'], filament: [], print: ['0.12mm Fine @Acme', '0.20mm Standard @Acme'] },
    OrcaFilamentLibrary: { printer: [], filament: ['Generic PLA @System'], print: [] },
  },
  '/settings-schema.json': schema,
  '/settings-defaults.json': defaults,
};
for (let i = 0; i < 256; i++) assetFiles[`/profiles/h/presets/${i}.json`] = shards[i] ?? {};
const env: ServerEnv = {
  GOOGLE_CLIENT_SECRET: 'test-secret',
  ASSETS: { fetch: async (p) => (p in assetFiles ? Response.json(assetFiles[p]) : new Response(null, { status: 404 })) },
};

// ── fake Google: token endpoint and Drive ──────────────────────────────────────────────────────
interface DriveFile {
  id: string;
  name: string;
  parents: string[];
  mimeType: string;
  content: string;
}
const FOLDER = 'application/vnd.google-apps.folder';
let drive: DriveFile[];
let nextId: number;
let googleTokenCalls: URLSearchParams[];
let googleTokenReply: () => Response;

function addFile(name: string, parent: string, content = '', mimeType = 'application/json') {
  const f = { id: `f${nextId++}`, name, parents: [parent], mimeType, content };
  drive.push(f);
  return f.id;
}

beforeEach(() => {
  drive = [];
  nextId = 1;
  googleTokenCalls = [];
  googleTokenReply = () =>
    Response.json({
      access_token: 'g-access',
      refresh_token: 'g-refresh',
      expires_in: 3600,
      scope: 'https://www.googleapis.com/auth/drive.file',
    });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input);
      if (input === GOOGLE_TOKEN) {
        googleTokenCalls.push(new URLSearchParams(String(init.body)));
        return googleTokenReply();
      }
      // Cloudflare's fetch refuses redirect: 'error'.
      if (init.redirect && init.redirect !== 'follow' && init.redirect !== 'manual') throw new TypeError('Invalid redirect value');
      if (input === CLIENT_DOC)
        return Response.json({ client_id: CLIENT_DOC, client_name: 'Doc App', redirect_uris: [REDIRECT, 'docapp://callback'] });
      if (url.host !== 'www.googleapis.com') return new Response('not found', { status: 404 });
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer g-access');
      const method = init.method ?? 'GET';
      const m = /^\/(upload\/)?drive\/v3\/files\/?([\w]*)$/.exec(url.pathname);
      if (!m) return new Response('bad path', { status: 400 });
      const [, upload, id] = m;
      if (method === 'GET' && !id) {
        const parent = /'([^']+)' in parents/.exec(url.searchParams.get('q') ?? '')![1]!;
        const files = drive
          .filter((f) => f.parents.includes(parent))
          .map(({ id, name, mimeType }) => ({ id, name, mimeType, version: '1', modifiedTime: '2026-01-01T00:00:00Z' }));
        return Response.json({ files });
      }
      if (method === 'GET' && url.searchParams.get('alt') === 'media') return new Response(drive.find((f) => f.id === id)!.content);
      if (method === 'POST' && !upload) {
        const b = JSON.parse(String(init.body));
        return Response.json({ id: addFile(b.name, b.parents[0], '', b.mimeType) });
      }
      if (method === 'POST' && upload) {
        // Multipart: metadata, then the content.
        const parts = String(init.body).split(/--dolphin\w+/);
        const meta = JSON.parse(parts[1]!.split('\r\n\r\n')[1]!.trim());
        const content = parts[2]!.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, '');
        return Response.json({ id: addFile(meta.name, meta.parents[0], content), version: '1' });
      }
      if (method === 'PATCH' && upload) {
        drive.find((f) => f.id === id)!.content = String(init.body);
        return Response.json({ id, version: '2' });
      }
      return new Response('unsupported', { status: 400 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

// ── helpers ───────────────────────────────────────────────────────────────────────────────────
async function call(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set('cookie', init.cookie);
  const r = await handleRequest(new Request(`${ORIGIN}${path}`, { ...init, headers }), env);
  expect(r).not.toBeNull();
  return r!;
}
const cookieOf = (r: Response, name: string) =>
  r.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`))
    ?.split(';')[0];
const form = (v: Record<string, string>) => ({ method: 'POST', body: new URLSearchParams(v) });

/** The whole sign-in: register, consent, Google, code, token. */
async function signIn() {
  const reg = await (
    await call('/mcp/register', { method: 'POST', body: JSON.stringify({ client_name: 'Test App', redirect_uris: [REDIRECT] }) })
  ).json();
  const verifier = 'v'.repeat(50);
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: reg.client_id,
    redirect_uri: REDIRECT,
    code_challenge: await s256(verifier),
    code_challenge_method: 'S256',
    state: 'client-state',
    resource: `${ORIGIN}/mcp`,
  });
  const page = await call(`/mcp/authorize?${q}`);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('Test App');
  expect(html).toContain('client.example');
  const sealed = /name="request" value="([^"]+)"/.exec(html)![1]!;
  const toGoogle = await call('/mcp/authorize', { ...form({ request: sealed, allow: '1' }), cookie: cookieOf(page, 'ds_mcp_consent') });
  expect(toGoogle.status).toBe(302);
  const google = new URL(toGoogle.headers.get('location')!);
  expect(google.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback`);
  expect(google.searchParams.get('prompt')).toBe('consent');
  const back = await call(`/api/auth/callback?state=${google.searchParams.get('state')}&code=google-code`, {
    cookie: cookieOf(toGoogle, 'ds_mcp_flow'),
  });
  const to = new URL(back.headers.get('location')!);
  expect(to.origin + to.pathname).toBe(REDIRECT);
  expect(to.searchParams.get('state')).toBe('client-state');
  expect(to.searchParams.get('iss')).toBe(ORIGIN);
  const tokens = await (
    await call(
      '/mcp/token',
      form({
        grant_type: 'authorization_code',
        code: to.searchParams.get('code')!,
        client_id: reg.client_id,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      }),
    )
  ).json();
  expect(tokens.token_type).toBe('Bearer');
  return { tokens, reg, verifier, code: to.searchParams.get('code')! };
}

let id = 0;
async function rpc(token: string, method: string, params: Record<string, unknown> = {}, modern = true) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  if (modern) {
    params = {
      ...params,
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} },
    };
    headers['mcp-protocol-version'] = '2026-07-28';
    headers['mcp-method'] = method;
    if (method === 'tools/call') headers['mcp-name'] = String(params.name);
  }
  return call('/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
}
async function tool(token: string, name: string, args: Record<string, unknown> = {}) {
  const r = await (await rpc(token, 'tools/call', { name, arguments: args })).json();
  return { error: r.result.isError as boolean, text: r.result.content[0].text as string, data: r.result.structuredContent };
}

// ── tests ─────────────────────────────────────────────────────────────────────────────────────
describe('sign-in', () => {
  it('describes itself', async () => {
    const prm = await (await call('/.well-known/oauth-protected-resource/mcp')).json();
    expect(prm).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
    const as = await (await call('/.well-known/oauth-authorization-server')).json();
    expect(as).toMatchObject({ issuer: ORIGIN, code_challenge_methods_supported: ['S256'], client_id_metadata_document_supported: true });
  });

  it('asks for a token with where to sign in', async () => {
    const r = await call('/mcp', { method: 'POST', body: '{}' });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
    const bad = await call('/mcp', { method: 'POST', body: '{}', headers: { authorization: 'Bearer nope' } });
    expect(bad.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('signs in, refreshes, and rejects what does not fit', async () => {
    const { tokens, reg, verifier, code } = await signIn();
    expect(googleTokenCalls[0]!.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback`);
    // A wrong PKCE verifier or client is refused.
    const wrong = await call(
      '/mcp/token',
      form({ grant_type: 'authorization_code', code, client_id: reg.client_id, redirect_uri: REDIRECT, code_verifier: `${verifier}x` }),
    );
    expect((await wrong.json()).error).toBe('invalid_grant');
    // Refreshing goes to Google with its refresh token.
    googleTokenReply = () => Response.json({ access_token: 'g-access', expires_in: 3600 });
    const fresh = await (
      await call('/mcp/token', form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: reg.client_id }))
    ).json();
    expect(googleTokenCalls[1]!.get('refresh_token')).toBe('g-refresh');
    expect(fresh.access_token).toBeTruthy();
    // Revoked at Google: sign in again.
    googleTokenReply = () => new Response('{}', { status: 400 });
    const revoked = await call('/mcp/token', form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }));
    expect((await revoked.json()).error).toBe('invalid_grant');
  });

  it('takes clients named by a metadata document', async () => {
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_DOC,
      redirect_uri: REDIRECT,
      code_challenge: 'c'.repeat(43),
      code_challenge_method: 'S256',
    });
    const page = await call(`/mcp/authorize?${q}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Connect Doc App to DolphinSlicer?');
    q.set('client_id', 'https://client.example/other.json');
    expect((await call(`/mcp/authorize?${q}`)).status).toBe(400);
  });

  it('refuses unknown redirects and consent from elsewhere', async () => {
    const reg = await (await call('/mcp/register', { method: 'POST', body: JSON.stringify({ redirect_uris: [REDIRECT] }) })).json();
    const q = (redirect: string) =>
      new URLSearchParams({
        response_type: 'code',
        client_id: reg.client_id,
        redirect_uri: redirect,
        code_challenge: 'c'.repeat(43),
        code_challenge_method: 'S256',
      });
    expect((await call(`/mcp/authorize?${q('https://evil.example/cb')}`)).status).toBe(400);
    const page = await call(`/mcp/authorize?${q(REDIRECT)}`);
    const sealed = /name="request" value="([^"]+)"/.exec(await page.text())![1]!;
    // Without the page's cookie (another site posting the form), nothing happens.
    expect((await call('/mcp/authorize', form({ request: sealed, allow: '1' }))).status).toBe(400);
    // Canceled: back to the app with access_denied.
    const cancel = await call('/mcp/authorize', { ...form({ request: sealed, allow: '0' }), cookie: cookieOf(page, 'ds_mcp_consent') });
    expect(new URL(cancel.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
    // Registration only takes https or loopback redirects.
    expect(
      (await call('/mcp/register', { method: 'POST', body: JSON.stringify({ redirect_uris: ['http://example.com/cb'] }) })).status,
    ).toBe(400);
  });
});

describe('protocol', () => {
  it('serves the current era', async () => {
    const { tokens } = await signIn();
    const d = await (await rpc(tokens.access_token, 'server/discover')).json();
    expect(d.result).toMatchObject({
      resultType: 'complete',
      supportedVersions: expect.arrayContaining(['2026-07-28', '2025-06-18']),
      capabilities: { tools: {} },
    });
    const list = await (await rpc(tokens.access_token, 'tools/list')).json();
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual([
      'get_setup',
      'get_preset',
      'compare_presets',
      'explain_setting',
      'find_profiles',
      'save_preset',
    ]);
    expect(list.result.cacheScope).toBe('public');
    // Headers must repeat the request.
    const r = await call('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens.access_token}`, 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
      }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe(-32020);
    const v = await call('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens.access_token}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } },
      }),
    });
    expect((await v.json()).error.code).toBe(-32022);
  });

  it('serves the earlier era', async () => {
    const { tokens } = await signIn();
    const init = await (
      await rpc(
        tokens.access_token,
        'initialize',
        { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
        false,
      )
    ).json();
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'dolphinslicer' } });
    const note = await call('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens.access_token}` },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(note.status).toBe(202);
    const list = await (await rpc(tokens.access_token, 'tools/list', {}, false)).json();
    expect(list.result.tools).toHaveLength(6);
    expect((await call('/mcp', { headers: { authorization: `Bearer ${tokens.access_token}` } })).status).toBe(405);
  });
});

describe('tools', () => {
  let token: string;
  beforeEach(async () => {
    token = (await signIn()).tokens.access_token;
  });

  /** The user's synced data: settings and one print preset. */
  function userData() {
    const app = addFile('DolphinSlicer', 'root', '', FOLDER);
    addFile(
      'settings.json',
      app,
      JSON.stringify({
        version: 1,
        settings: {
          selection: {
            value: { vendor: 'Acme', printer: 'Acme Cube 0.4 nozzle', process: 'Strong', filament: 'Generic PLA @System' },
            modified: 1,
          },
          library: {
            value: { printers: [{ vendor: 'Acme', model: 'Acme Cube', nozzle: '0.4' }], filaments: ['Generic PLA'], vendors: [] },
            modified: 1,
          },
          units: { value: 'metric', modified: 1 },
        },
      }),
    );
    const presets = addFile('Presets', app, '', FOLDER);
    const process = addFile('process', presets, '', FOLDER);
    addFile(
      'Strong.json',
      process,
      JSON.stringify({
        from: 'User',
        inherits: '0.20mm Standard @Acme',
        name: 'Strong',
        print_settings_id: 'Strong',
        version: '1.2.3',
        wall_loops: '5',
      }),
    );
    return { process };
  }

  it('reads the setup, presets and settings', async () => {
    userData();
    const setup = await tool(token, 'get_setup');
    expect(setup.data).toMatchObject({
      selected: { printer: 'Acme Cube 0.4 nozzle', print: 'Strong', filament: 'Generic PLA @System' },
      user_presets: { print: ['Strong'], printer: [], filament: [] },
      units: 'metric',
    });
    const strong = await tool(token, 'get_preset', { type: 'print', name: 'Strong' });
    expect(strong.data).toMatchObject({ source: 'user', inherits: '0.20mm Standard @Acme', own: { wall_loops: '5' } });
    expect(strong.data.values).toMatchObject({ wall_loops: '5', sparse_infill_density: '15%', layer_height: '0.2' });
    const printer = await tool(token, 'get_preset', { type: 'printer', name: 'Acme Cube 0.4 nozzle', keys: ['machine_start_gcode'] });
    expect(printer.data.values).toEqual({ machine_start_gcode: 'G28\nM117 Acme' });
    const cmp = await tool(token, 'compare_presets', { type: 'print', a: 'Strong', b: '0.12mm Fine @Acme' });
    expect(cmp.data.differences.map((d: { key: string }) => d.key).sort()).toEqual(['layer_height', 'sparse_infill_density', 'wall_loops']);
    expect((await tool(token, 'get_preset', { type: 'print', name: 'Nope' })).error).toBe(true);
    expect((await tool(token, 'explain_setting', { key: 'sparse_infill_pattern' })).data).toMatchObject({
      preset_type: 'print',
      options: [
        { value: 'grid', label: 'Grid' },
        { value: 'gyroid', label: 'Gyroid' },
      ],
    });
    expect((await tool(token, 'explain_setting', { search: 'walls' })).data.matches[0].key).toBe('wall_loops');
    expect((await tool(token, 'find_profiles', { type: 'print', search: 'fine' })).data.presets).toEqual([
      { name: '0.12mm Fine @Acme', vendor: 'Acme' },
    ]);
  });

  it('reads presets with no parent from base/, and saves them there', async () => {
    const app = addFile('DolphinSlicer', 'root', '', FOLDER);
    const presets = addFile('Presets', app, '', FOLDER);
    const machine = addFile('machine', presets, '', FOLDER);
    addFile(
      'Child.json',
      machine,
      JSON.stringify({ from: 'User', inherits: 'Custom', name: 'Child', printer_settings_id: 'Child', nozzle_diameter: ['0.6'] }),
    );
    const base = addFile('base', machine, '', FOLDER);
    addFile(
      'Custom.json',
      base,
      JSON.stringify({ from: 'User', inherits: '', name: 'Custom', printer_settings_id: 'Custom', nozzle_diameter: ['0.5'] }),
    );
    expect((await tool(token, 'get_setup')).data.user_presets.printer).toEqual(['Child', 'Custom']);
    expect(
      (await tool(token, 'get_preset', { type: 'printer', name: 'Child', keys: ['nozzle_diameter', 'machine_start_gcode'] })).data,
    ).toMatchObject({
      inherits: 'Custom',
      values: { nozzle_diameter: ['0.6'], machine_start_gcode: 'G28' },
    });
    // A copy of a printer with no parent has none either: it goes to base/.
    await tool(token, 'save_preset', { type: 'printer', name: 'Copy', base: 'Custom', changes: { nozzle_diameter: '0.8' } });
    expect(drive.find((x) => x.name === 'Copy.json')!.parents[0]).toBe(base);
    await tool(token, 'save_preset', { type: 'printer', name: 'Custom', changes: { nozzle_diameter: '0.4' } });
    expect(JSON.parse(drive.find((x) => x.name === 'Custom.json')!.content).nozzle_diameter).toEqual(['0.4']);
  });

  it('says when nothing is synced', async () => {
    expect((await tool(token, 'get_setup')).data.note).toMatch(/Google Drive sync/);
  });

  it('saves presets as desktop writes them', async () => {
    const { process } = userData();
    // A change to an existing user preset; a value back at the parent's is dropped.
    const r = await tool(token, 'save_preset', {
      type: 'print',
      name: 'Strong',
      changes: { sparse_infill_pattern: 'Gyroid', layer_height: 0.16, sparse_infill_density: '15' },
    });
    expect(r.error).toBe(false);
    expect(r.data).toMatchObject({
      result: 'updated',
      changed: { sparse_infill_pattern: 'gyroid', layer_height: '0.16', sparse_infill_density: '15%' },
    });
    const file = drive.find((f) => f.parents[0] === process && f.name === 'Strong.json')!;
    expect(JSON.parse(file.content)).toEqual({
      from: 'User',
      inherits: '0.20mm Standard @Acme',
      layer_height: '0.16',
      name: 'Strong',
      print_settings_id: 'Strong',
      sparse_infill_pattern: 'gyroid',
      version: '1.2.3',
      wall_loops: '5',
    });
    expect(file.content.split('\n')[1]).toBe('\t"from": "User",');

    // A new filament from a system preset: lists filled per element, a folder made for it.
    const pla = await tool(token, 'save_preset', {
      type: 'filament',
      name: 'My PLA',
      base: 'Generic PLA @System',
      changes: { nozzle_temperature: 215 },
    });
    expect(pla.data.result).toBe('created');
    const f = drive.find((x) => x.name === 'My PLA.json')!;
    expect(drive.find((x) => x.id === f.parents[0])!.name).toBe('filament');
    expect(JSON.parse(f.content)).toEqual({
      filament_settings_id: ['My PLA'],
      from: 'User',
      inherits: 'Generic PLA @System',
      name: 'My PLA',
      nozzle_temperature: ['215'],
    });

    // G-code keeps desktop's escaping in the file and reads back as text.
    await tool(token, 'save_preset', {
      type: 'printer',
      name: 'My Cube',
      base: 'Acme Cube 0.4 nozzle',
      changes: { machine_start_gcode: 'G28\nG1 Z5' },
    });
    expect(JSON.parse(drive.find((x) => x.name === 'My Cube.json')!.content).machine_start_gcode).toBe('G28\\nG1 Z5');
    expect(
      (await tool(token, 'get_preset', { type: 'printer', name: 'My Cube', keys: ['machine_start_gcode'] })).data.values
        .machine_start_gcode,
    ).toBe('G28\nG1 Z5');
  });

  it('refuses what cannot be saved', async () => {
    userData();
    const errs = async (args: Record<string, unknown>) => {
      const r = await tool(token, 'save_preset', args);
      expect(r.error).toBe(true);
      return r.text;
    };
    expect(await errs({ type: 'print', name: 'Strong', changes: { wall_loops: '2.5', layer_height: '0,2', nope: 1 } })).toMatch(
      /Nothing was saved.*wall_loops: expected a whole number.*layer_height: use a dot.*nope: not a print setting/,
    );
    expect(await errs({ type: 'print', name: '0.12mm Fine @Acme', base: 'Strong', changes: {} })).toMatch(/system preset name/);
    expect(await errs({ type: 'print', name: 'New', changes: {} })).toMatch(/Give base/);
    expect(await errs({ type: 'print', name: 'Strong', base: '0.12mm Fine @Acme', changes: {} })).toMatch(/exists/);
    expect(await errs({ type: 'print', name: 'a/b', base: 'Strong', changes: {} })).toMatch(/cannot contain/);
    expect(await errs({ type: 'print', name: 'X', base: 'fdm_process_common', changes: {} })).toMatch(/base profile/);
    expect(await errs({ type: 'print', name: 'Strong', changes: { sparse_infill_density: '150%' } })).toMatch(/at most 100/);
    expect(await errs({ type: 'print', name: 'Strong', changes: { inherits: 'x' } })).toMatch(/cannot be changed/);
  });
});
