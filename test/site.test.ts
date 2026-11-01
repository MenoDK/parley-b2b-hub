import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE_URL, type World, startWorld } from './harness.js';

const SITE_DIR = fileURLToPath(new URL('../site', import.meta.url));

describe.skipIf(!DATABASE_URL)('the demo site served by the shop', () => {
  let world: World;
  beforeAll(async () => {
    // An absolute SITE_DIR is what the container uses (/app/site); a relative one must work too.
    world = await startWorld({ originEnv: { SITE_DIR } });
  });
  afterAll(async () => {
    await world.close();
  });
  const get = (url: string) => world.origin.built.app.inject({ method: 'GET', url });

  it('serves the landing page, the lab and the assets with a strict content security policy', async () => {
    for (const [url, type] of [
      ['/', 'text/html'],
      ['/lab.html', 'text/html'],
      ['/kit.js', 'javascript'],
      ['/kit.css', 'text/css'],
      ['/favicon.svg', 'svg'],
    ] as const) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type'], url).toContain(type);
      expect(res.headers['content-security-policy'], url).toContain("script-src 'self'");
      expect(res.headers['content-security-policy'], url).not.toContain('unsafe-inline');
    }
  });

  it('does not put the page policy on the API, and answers unknown API paths as JSON', async () => {
    const api = await get('/v1/lab/config');
    expect(api.headers['content-security-policy']).toBeUndefined();
    const missing = await get('/v1/nothing-here');
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('serves nothing outside the site folder', async () => {
    for (const url of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/src/app.ts']) {
      expect((await get(url)).statusCode, url).toBe(404);
    }
  });

  it('is off when SITE_DIR is empty: the partner serves only its API', async () => {
    expect((await world.partner.built.app.inject({ method: 'GET', url: '/' })).statusCode).toBe(404);
  });
});
