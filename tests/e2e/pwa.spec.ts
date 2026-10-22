import { expect, test } from '@playwright/test';

// PWA plumbing only (manifest, icons, service worker). Nothing here depends on the app's UI.

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

interface Manifest {
  id: string;
  name: string;
  short_name: string;
  description: string;
  start_url: string;
  scope: string;
  display: string;
  orientation: string;
  background_color: string;
  theme_color: string;
  categories: string[];
  icons: ManifestIcon[];
  shortcuts: { name: string; url: string; icons?: ManifestIcon[] }[];
  share_target: { action: string; method: string; params: Record<string, string> };
}

const CACHE_NAME = /^whatstime-v\d+$/;

function siteUrl(path: string, baseURL: string | undefined): URL {
  return new URL(path, `${baseURL ?? 'http://localhost:4173'}/`);
}

/** Width/height from a PNG's IHDR chunk. */
function pngSize(png: Buffer): { width: number; height: number } {
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(png.subarray(12, 16).toString('latin1')).toBe('IHDR');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

test.describe('web app manifest', () => {
  test('is served as JSON with the install fields', async ({ request, baseURL }) => {
    const res = await request.get(siteUrl('manifest.webmanifest', baseURL).href);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/^application\/(manifest\+)?json/);
    const manifest = (await res.json()) as Manifest;

    expect(manifest.name).toBe('WhatsTime – scheduled WhatsApp reminders');
    expect(manifest.short_name).toBe('WhatsTime');
    expect(manifest.description.length).toBeGreaterThan(10);
    expect(manifest).toMatchObject({
      start_url: './',
      scope: './',
      display: 'standalone',
      orientation: 'portrait',
      categories: ['productivity'],
    });
    expect(typeof manifest.id).toBe('string');
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);

    const icon = (pred: (i: ManifestIcon) => boolean) => manifest.icons.find(pred);
    const purposes = (i: ManifestIcon) => (i.purpose ?? 'any').split(/\s+/);
    expect(icon((i) => i.sizes === '192x192' && i.type === 'image/png' && purposes(i).includes('any'))).toBeTruthy();
    expect(icon((i) => i.sizes === '512x512' && i.type === 'image/png' && purposes(i).includes('any'))).toBeTruthy();
    expect(icon((i) => i.sizes === '512x512' && i.type === 'image/png' && purposes(i).includes('maskable'))).toBeTruthy();
    expect(icon((i) => i.sizes === 'any' && i.type === 'image/svg+xml')).toBeTruthy();

    expect(manifest.share_target).toEqual({
      action: './',
      method: 'GET',
      params: { title: 'title', text: 'text', url: 'url' },
    });
    expect(manifest.shortcuts.map(({ name, url }) => ({ name, url }))).toEqual([
      { name: 'New reminder', url: './#/' },
      { name: 'Scheduled', url: './#/scheduled' },
    ]);

    // GitHub Pages serves the app from a sub-path: nothing may be root-absolute or absolute.
    const urls = [
      manifest.id,
      manifest.start_url,
      manifest.scope,
      manifest.share_target.action,
      ...manifest.icons.map((i) => i.src),
      ...manifest.shortcuts.flatMap((s) => [s.url, ...(s.icons ?? []).map((i) => i.src)]),
    ];
    for (const url of urls) expect(url, url).not.toMatch(/^(\/|[a-z][a-z\d+.-]*:)/i);
  });

  test('every icon it lists resolves with the right type and size', async ({ request, baseURL }) => {
    const manifestUrl = siteUrl('manifest.webmanifest', baseURL);
    const manifest = (await (await request.get(manifestUrl.href)).json()) as Manifest;
    const icons = [...manifest.icons, ...manifest.shortcuts.flatMap((s) => s.icons ?? [])];
    expect(icons.length).toBeGreaterThanOrEqual(4);

    for (const icon of icons) {
      const url = new URL(icon.src, manifestUrl).href;
      const res = await request.get(url);
      expect(res.status(), url).toBe(200);
      expect(res.headers()['content-type'], url).toContain(icon.type);
      const body = await res.body();
      if (icon.type === 'image/png') {
        const { width, height } = pngSize(body);
        expect(`${width}x${height}`, url).toBe(icon.sizes);
      } else {
        expect(body.toString('utf8'), url).toContain('<svg');
      }
    }
  });
});

test.describe('service worker', () => {
  test('is served and everything it precaches resolves', async ({ request, baseURL }) => {
    const swUrl = siteUrl('sw.js', baseURL);
    const res = await request.get(swUrl.href);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/javascript/);
    const source = await res.text();
    expect(source).toContain('whatstime-');
    expect(source).toContain("addEventListener('fetch'");

    const list = /const PRECACHE = \[([\s\S]*?)\];/.exec(source)?.[1];
    expect(list, 'PRECACHE array in sw.js').toBeTruthy();
    const entries = [...(list ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
    expect(entries).toEqual(expect.arrayContaining(['./', './index.html', './manifest.webmanifest']));
    for (const entry of entries) {
      expect(entry, entry).toMatch(/^\.\//);
      const url = new URL(entry, swUrl).href;
      expect((await request.get(url)).status(), url).toBe(200);
    }
  });

  test('takes control and serves the app shell offline', async ({ page, context, baseURL }) => {
    // Without this flag Playwright neither routes nor takes offline the service worker's own
    // fetches, so an "offline" check would quietly still reach the server. It is read whenever a
    // service worker starts, so setting it here only affects this test.
    const flag = 'PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS';
    const previous = process.env[flag];
    process.env[flag] = '1';
    try {
      const root = siteUrl('./', baseURL);
      const online = await page.goto(root.href);
      expect(online?.status()).toBe(200);
      const shellHtml = await online!.text();

      // Register explicitly so this test does not depend on the app's registration code.
      await page.evaluate(async () => {
        await navigator.serviceWorker.register('sw.js');
        await navigator.serviceWorker.ready;
      });
      await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

      const cached = await page.evaluate(async () => {
        const names = (await caches.keys()).filter((n) => n.startsWith('whatstime-'));
        const keys = names[0] ? await (await caches.open(names[0])).keys() : [];
        return { names, paths: keys.map((r) => new URL(r.url).pathname) };
      });
      expect(cached.names).toHaveLength(1);
      expect(cached.names[0]).toMatch(CACHE_NAME);
      expect(cached.paths).toEqual(
        expect.arrayContaining([root.pathname, `${root.pathname}index.html`, `${root.pathname}manifest.webmanifest`]),
      );
      // The build's hashed JS/CSS was downloaded before the worker existed; install caches it.
      const assetPaths = [...shellHtml.matchAll(/\s(?:src|href)="(?:\.\/)?(assets\/[^"]+)"/g)].map(
        (m) => `${root.pathname}${m[1] ?? ''}`,
      );
      expect(cached.paths).toEqual(expect.arrayContaining(assetPaths));

      // Cut the network for the page and the service worker, and prove it is really cut.
      await context.route('**/*', (route) => route.abort('internetdisconnected'));
      const probe = await page.evaluate(() =>
        fetch(`offline-probe-${Date.now()}`).then(
          () => 'reached the network',
          () => 'blocked',
        ),
      );
      expect(probe).toBe('blocked');

      // Page responses only: the worker's own background refreshes are expected to fail here.
      const assetResponses = new Map<string, string>();
      page.on('response', (res) => {
        if (res.request().serviceWorker()) return;
        assetResponses.set(new URL(res.url()).pathname, `${res.status()} ${res.fromServiceWorker() ? 'sw' : 'net'}`);
      });
      const reloaded = await page.reload();
      expect(reloaded?.status()).toBe(200);
      expect(reloaded?.fromServiceWorker()).toBe(true);
      expect(await reloaded!.text()).toBe(shellHtml);
      for (const asset of assetPaths) expect(assetResponses.get(asset), asset).toBe('200 sw');

      // A share-target launch (GET with query params) gets the shell too.
      const shareUrl = siteUrl('./?title=Hi&text=See%20you&url=https%3A%2F%2Fexample.com', baseURL);
      const shared = await page.goto(shareUrl.href);
      expect(shared?.status()).toBe(200);
      expect(shared?.fromServiceWorker()).toBe(true);
      expect(await shared!.text()).toBe(shellHtml);
    } finally {
      if (previous === undefined) delete process.env[flag];
      else process.env[flag] = previous;
    }
  });
});
