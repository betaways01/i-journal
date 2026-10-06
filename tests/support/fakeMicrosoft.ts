/**
 * A fake of the parts of Microsoft identity + OneNote Graph the app uses, as a fetch implementation.
 * It behaves like the real thing where it matters: PKCE is checked, a redirect registered as a
 * single-page app demands an Origin and no secret (and its sign-ins die after a day), device codes
 * need "public client flows", PATCH targets must exist, throttling sends Retry-After.
 */
import crypto from 'crypto';

export interface FakePage {
  id: string;
  sectionId: string;
  title: string;
  /** Inside <div data-id="ij-text">, or null for pages written by something else. */
  text: string | null;
  appended: string[];
  images: Array<{ dataId: string; bytes: number }>;
  createdAt: number;
}

export interface FakeMicrosoftOptions {
  /** How the redirect URI is registered in Azure. */
  registration?: 'web' | 'spa';
  /** "Allow public client flows" (device code for personal accounts). */
  publicClientFlows?: boolean;
  clientId?: string;
  clientSecret?: string;
  upn?: string;
  displayName?: string;
  /** Graph answers OneNote with the SharePoint-license error. */
  noLicense?: boolean;
}

interface Grant {
  account: string;
  mode: 'web' | 'spa' | 'public';
  issuedAt: number;
}

export function createFakeMicrosoft(opts: FakeMicrosoftOptions = {}) {
  const clientId = opts.clientId ?? 'client-1';
  const clientSecret = opts.clientSecret ?? 'secret-1';
  let now = Date.now();
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const refresh = new Map<string, Grant>();
  const access = new Map<string, Grant>();
  const devices = new Map<string, { approved: boolean; declined?: boolean; expiresAt: number }>();
  const notebooks: Array<{ id: string; displayName: string }> = [];
  const sections: Array<{ id: string; notebookId: string; displayName: string }> = [];
  const pages: FakePage[] = [];
  const calls: Array<{ method: string; url: string; status: number }> = [];
  let seq = 0;
  const next = (p: string) => `${p}-${++seq}`;
  const failNext: Array<{ match: RegExp; status: number; retryAfter?: number; body?: unknown }> = [];

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const aad = (code: string, error = 'invalid_request', status = 400) => json(status, { error, error_description: `${code}: fake error` });

  function issue(account: string, mode: Grant['mode']) {
    const a = next('at');
    const r = next('rt');
    access.set(a, { account, mode, issuedAt: now });
    refresh.set(r, { account, mode, issuedAt: now });
    return json(200, { access_token: a, refresh_token: r, expires_in: 3600, token_type: 'Bearer' });
  }

  /** What shape this redemption has, and whether the registration accepts it. */
  function shapeError(body: URLSearchParams, headers: Headers, kind: 'redirect' | 'device'): Response | null {
    const hasSecret = body.has('client_secret');
    const hasOrigin = headers.has('origin');
    if (body.get('client_id') !== clientId) return aad('AADSTS700016', 'unauthorized_client');
    if (hasSecret && body.get('client_secret') !== clientSecret) return aad('AADSTS7000215', 'invalid_client', 401);
    if (kind === 'device') {
      if (opts.publicClientFlows && hasSecret) return aad('AADSTS700025', 'invalid_client');
      if (!opts.publicClientFlows && !hasSecret) return aad('AADSTS7000218', 'invalid_client');
      return null;
    }
    if (opts.registration === 'spa') {
      if (!hasOrigin) return aad('AADSTS9002327');
      if (hasSecret) return aad('AADSTS700025', 'invalid_client');
      return null;
    }
    if (hasOrigin) return aad('AADSTS9002326');
    if (!hasSecret) return aad('AADSTS7000218', 'invalid_client');
    return null;
  }

  async function token(body: URLSearchParams, headers: Headers): Promise<Response> {
    const grant = body.get('grant_type');
    if (grant === 'authorization_code') {
      const bad = shapeError(body, headers, 'redirect');
      if (bad) return bad;
      const c = codes.get(body.get('code') || '');
      if (!c) return aad('AADSTS70008', 'invalid_grant');
      const verifier = body.get('code_verifier') || '';
      if (crypto.createHash('sha256').update(verifier).digest('base64url') !== c.challenge) return aad('AADSTS501481', 'invalid_grant');
      if (body.get('redirect_uri') !== c.redirect) return aad('AADSTS50011', 'invalid_grant');
      codes.delete(body.get('code')!);
      return issue('me', opts.registration === 'spa' ? 'spa' : 'web');
    }
    if (grant === 'refresh_token') {
      const g = refresh.get(body.get('refresh_token') || '');
      if (!g) return aad('AADSTS70000', 'invalid_grant');
      const bad = shapeError(body, headers, g.mode === 'public' ? 'device' : 'redirect');
      if (bad) return bad;
      if (g.mode === 'spa' && now - g.issuedAt > 24 * 3_600_000) return aad('AADSTS700084', 'invalid_grant');
      refresh.delete(body.get('refresh_token')!);
      return issue(g.account, g.mode);
    }
    if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
      const bad = shapeError(body, headers, 'device');
      if (bad) return bad;
      const d = devices.get(body.get('device_code') || '');
      if (!d || d.expiresAt < now) return json(400, { error: 'expired_token', error_description: 'AADSTS70020: expired' });
      if (d.declined) return json(400, { error: 'authorization_declined', error_description: 'AADSTS70000: declined' });
      if (!d.approved) return json(400, { error: 'authorization_pending', error_description: 'AADSTS70016: pending' });
      devices.delete(body.get('device_code')!);
      return issue('me', 'public');
    }
    return aad('AADSTS70003', 'unsupported_grant_type');
  }

  function authed(headers: Headers): Grant | null {
    const m = /^Bearer (.+)$/.exec(headers.get('authorization') || '');
    return m ? access.get(m[1]) ?? null : null;
  }

  function pageJson(p: FakePage) {
    const s = sections.find((x) => x.id === p.sectionId)!;
    const nb = notebooks.find((x) => x.id === s.notebookId)!;
    return {
      id: p.id,
      title: p.title,
      lastModifiedDateTime: new Date(p.createdAt).toISOString(),
      links: { oneNoteClientUrl: { href: `onenote:https://onenote.example/${p.id}` }, oneNoteWebUrl: { href: `https://onenote.example/${p.id}` } },
      parentSection: { displayName: s.displayName },
      parentNotebook: { displayName: nb.displayName },
    };
  }

  function content(p: FakePage): string {
    return `<html><head><title>${p.title}</title></head><body>${p.text !== null ? `<div data-id="ij-text">${p.text}</div>` : ''}${p.appended.join('')}${p.images
      .map((i) => `<img data-id="${i.dataId}" src="https://graph.example/res/${i.dataId}" />`)
      .join('')}</body></html>`;
  }

  const WRAP = /^<div data-id="ij-text">([\s\S]*)<\/div>$/;

  async function graph(method: string, url: URL, init: RequestInit, headers: Headers): Promise<Response> {
    if (!authed(headers)) return json(401, { error: { code: 'InvalidAuthenticationToken', message: 'expired' } });
    const p = url.pathname.replace(/^\/v1\.0/, '');
    if (p === '/me') return json(200, { id: 'ms-1', displayName: opts.displayName ?? 'Test Person', mail: null, userPrincipalName: opts.upn ?? 'person@outlook.com' });
    if (opts.noLicense && p.startsWith('/me/onenote')) return json(403, { error: { code: '30121', message: 'The tenant does not have a valid SharePoint license.' } });
    if (p === '/me/onenote/notebooks' && method === 'GET') return json(200, { value: notebooks });
    if (p === '/me/onenote/notebooks' && method === 'POST') {
      const nb = { id: next('nb'), displayName: (JSON.parse(String(init.body)) as { displayName: string }).displayName };
      notebooks.push(nb);
      return json(201, nb);
    }
    let m = /^\/me\/onenote\/notebooks\/([^/]+)\/sections$/.exec(p);
    if (m && method === 'GET') return json(200, { value: sections.filter((s) => s.notebookId === decodeURIComponent(m![1])) });
    if (m && method === 'POST') {
      const s = { id: next('sec'), notebookId: decodeURIComponent(m[1]), displayName: (JSON.parse(String(init.body)) as { displayName: string }).displayName };
      sections.push(s);
      return json(201, s);
    }
    m = /^\/me\/onenote\/sections\/([^/]+)\/pages$/.exec(p);
    if (m && method === 'POST') {
      const sectionId = decodeURIComponent(m[1]);
      if (!sections.some((s) => s.id === sectionId)) return json(404, { error: { code: '20102', message: 'The specified resource ID does not exist.' } });
      const html = String(init.body);
      const title = /<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? '';
      const body = /<body>([\s\S]*)<\/body>/.exec(html)?.[1] ?? '';
      const wrapped = WRAP.exec(body);
      const page: FakePage = { id: next('page'), sectionId, title, text: wrapped ? wrapped[1] : null, appended: wrapped ? [] : [body], images: [], createdAt: now };
      pages.push(page);
      return json(201, pageJson(page));
    }
    if (m && method === 'GET') return json(200, { value: pages.filter((x) => x.sectionId === decodeURIComponent(m![1])).map(pageJson).reverse() });
    if (p === '/me/onenote/pages' && method === 'GET') return json(200, { value: [...pages].reverse().map(pageJson) });
    m = /^\/me\/onenote\/pages\/([^/]+)(\/content)?$/.exec(p);
    if (m) {
      const page = pages.find((x) => x.id === decodeURIComponent(m![1]));
      if (!page) return json(404, { error: { code: '20102', message: 'The specified resource ID does not exist.' } });
      if (!m[2] && method === 'GET') return json(200, pageJson(page));
      if (m[2] && method === 'GET') return new Response(content(page), { status: 200, headers: { 'content-type': 'text/html' } });
      if (m[2] && method === 'PATCH') {
        const type = headers.get('content-type') || '';
        if (type.startsWith('multipart/form-data')) {
          const raw = Buffer.from(init.body as Buffer).toString('latin1');
          const commands = JSON.parse(/name="Commands"\r\nContent-Type: application\/json\r\n\r\n([\s\S]*?)\r\n--/.exec(raw)![1]) as Array<{ content: string }>;
          const dataId = /data-id="([^"]+)"/.exec(commands[0].content)![1];
          const bin = /name="photo"\r\nContent-Type: [^\r]+\r\n\r\n([\s\S]*?)\r\n--/.exec(raw)![1];
          page.images.push({ dataId, bytes: bin.length });
          return new Response(null, { status: 204 });
        }
        const commands = JSON.parse(String(init.body)) as Array<{ target: string; action: string; content: string }>;
        for (const c of commands) {
          if (c.target === '#ij-text' && c.action === 'replace') {
            if (page.text === null) return json(400, { error: { code: '20136', message: "The given target 'ij-text' does not exist in the page." } });
            page.text = WRAP.exec(c.content)?.[1] ?? c.content;
          } else if (c.target === 'title' && c.action === 'replace') page.title = c.content;
          else if (c.target === 'body' && c.action === 'append') {
            const w = WRAP.exec(c.content);
            if (w) page.text = w[1];
            else page.appended.push(c.content);
          } else return json(400, { error: { code: '19999', message: `unsupported ${c.action} on ${c.target}` } });
        }
        return new Response(null, { status: 204 });
      }
    }
    return json(404, { error: { code: '20102', message: `no route ${method} ${p}` } });
  }

  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init.method || 'GET').toUpperCase();
    const headers = new Headers(init.headers as Record<string, string>);
    const injected = failNext.findIndex((f) => f.match.test(`${method} ${url.pathname}`));
    let res: Response;
    if (injected >= 0) {
      const f = failNext.splice(injected, 1)[0];
      res = json(f.status, f.body ?? { error: { code: String(f.status), message: 'injected' } }, f.retryAfter ? { 'retry-after': String(f.retryAfter) } : {});
    } else if (url.host === 'login.microsoftonline.com') {
      const body = new URLSearchParams(String(init.body || ''));
      if (url.pathname.endsWith('/oauth2/v2.0/token')) res = await token(body, headers);
      else if (url.pathname.endsWith('/oauth2/v2.0/devicecode')) {
        const tenant = url.pathname.split('/')[1];
        if (!opts.publicClientFlows && tenant !== 'organizations') res = aad('AADSTS70002', 'invalid_client');
        else {
          const dc = next('dc');
          devices.set(dc, { approved: false, expiresAt: now + 900_000 });
          res = json(200, { device_code: dc, user_code: 'ABCD-1234', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 1, message: 'To sign in, use a web browser…' });
        }
      } else res = json(404, {});
    } else if (url.host === 'graph.microsoft.com') res = await graph(method, url, init, headers);
    else res = json(404, {});
    calls.push({ method, url: url.pathname + url.search, status: res.status });
    return res;
  }) as typeof fetch;

  return {
    fetchImpl,
    clientId,
    clientSecret,
    notebooks,
    sections,
    pages,
    calls,
    /** What the browser does after the person signs in: Microsoft issues a code bound to the PKCE challenge. */
    signInVia(authorizeUrl: string): { code: string; state: string } {
      const u = new URL(authorizeUrl);
      const code = next('code');
      codes.set(code, { challenge: u.searchParams.get('code_challenge') || '', redirect: u.searchParams.get('redirect_uri') || '' });
      return { code, state: u.searchParams.get('state') || '' };
    },
    approveDevice(): void {
      for (const d of devices.values()) d.approved = true;
    },
    declineDevice(): void {
      for (const d of devices.values()) d.declined = true;
    },
    advance(ms: number): void {
      now += ms;
    },
    now: () => now,
    /** Makes the next matching request fail, e.g. fail(/PATCH/, 429, 1). */
    fail(match: RegExp, status: number, retryAfter?: number, body?: unknown): void {
      failNext.push({ match, status, retryAfter, body });
    },
    revokeAccessTokens(): void {
      access.clear();
    },
    addForeignPage(notebook: string, section: string, title: string, html: string): FakePage {
      let nb = notebooks.find((n) => n.displayName === notebook);
      if (!nb) notebooks.push((nb = { id: next('nb'), displayName: notebook }));
      let s = sections.find((x) => x.notebookId === nb!.id && x.displayName === section);
      if (!s) sections.push((s = { id: next('sec'), notebookId: nb.id, displayName: section }));
      const page: FakePage = { id: next('page'), sectionId: s.id, title, text: null, appended: [html], images: [], createdAt: now };
      pages.push(page);
      return page;
    },
  };
}

export type FakeMicrosoft = ReturnType<typeof createFakeMicrosoft>;
