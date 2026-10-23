#!/usr/bin/env node
// Generates the WhatsTime app icons into public/icons/: SVG sources plus PNGs rasterised with
// Playwright's Chromium. Run with `node scripts/generate-icons.mjs` and commit the output.
//
// The mark is original: a rounded "outgoing message" bubble (tail bottom-right) with a clock face.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public', 'icons');
const TEAL = '#0b8f6f';
const WHITE = '#ffffff';

// Bubble + clock drawn on a 512x512 grid; the body is centred on (256, 232). `bold` thickens the
// clock strokes so the favicon still reads at 16px.
const mark = ({ bold = false } = {}) => [
  // Speech bubble: rounded body with a short tail out of the bottom-right corner.
  `<path fill="${WHITE}" d="M176 80H336A104 104 0 0 1 440 184V316C440 352 446 386 462 414C428 410 396 398 372 380C360 383 348 384 336 384H176A104 104 0 0 1 72 280V184A104 104 0 0 1 176 80Z"/>`,
  // Clock face showing four o'clock.
  `<circle cx="256" cy="232" r="${bold ? 100 : 104}" fill="none" stroke="${TEAL}" stroke-width="${bold ? 44 : 30}"/>`,
  `<path d="M256 232V${bold ? 176 : 170}M256 232L${bold ? '294 254' : '298 256'}" fill="none" stroke="${TEAL}" stroke-width="${bold ? 40 : 28}" stroke-linecap="round" stroke-linejoin="round"/>`,
].join('');

// Moves the mark's bounding box (x 72..462, y 80..414) close to the canvas centre.
const CENTRE = 'translate(-4 10)';

/** Rounded tile for "any" icons and the favicon: transparent outside the tile. */
function tileSvg(options) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="${TEAL}"/><g transform="${CENTRE}">${mark(options)}</g></svg>\n`;
}

/** Full-bleed square with the mark shrunk around the centre (maskable, apple-touch-icon). */
function fullBleedSvg(scale) {
  const t = `translate(256 256) scale(${scale}) translate(-256 -256) ${CENTRE}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="${TEAL}"/><g transform="${t}">${mark()}</g></svg>\n`;
}

const OUTPUTS = [
  { file: 'icon-192.png', size: 192, svg: tileSvg() },
  { file: 'icon-512.png', size: 512, svg: tileSvg() },
  // Maskable safe zone: circle of radius 40% (204.8px at 512). The mark's farthest point (tail tip)
  // is ~263px from the centre, so 0.76 puts it at ~200px; the body stays well inside.
  { file: 'maskable-512.png', size: 512, svg: fullBleedSvg(0.76) },
  // iOS rounds the corners itself and needs an opaque image.
  { file: 'apple-touch-icon.png', size: 180, svg: fullBleedSvg(0.8) },
];

async function loadChromium() {
  const candidates = [
    '@playwright/test',
    'playwright',
    pathToFileURL('/opt/node22/lib/node_modules/playwright/index.mjs').href,
  ];
  for (const spec of candidates) {
    try {
      const mod = await import(spec);
      if (mod.chromium) return mod.chromium;
    } catch {
      // try the next one
    }
  }
  throw new Error('Playwright is not installed. Run `npm ci` (it provides @playwright/test).');
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, 'icon.svg'), tileSvg());
  await writeFile(path.join(OUT_DIR, 'favicon.svg'), tileSvg({ bold: true }));

  const chromium = await loadChromium();
  const localChromium = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(existsSync(localChromium) ? { executablePath: localChromium } : {});
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const { file, size, svg } of OUTPUTS) {
      await page.setViewportSize({ width: size, height: size });
      const sized = svg.replace('<svg ', `<svg width="${size}" height="${size}" `);
      await page.setContent(
        `<!doctype html><html><head><style>html,body{margin:0;background:transparent}svg{display:block}</style></head><body>${sized}</body></html>`,
      );
      await page.screenshot({
        path: path.join(OUT_DIR, file),
        clip: { x: 0, y: 0, width: size, height: size },
        omitBackground: true,
      });
      console.log(`wrote public/icons/${file} (${size}x${size})`);
    }
  } finally {
    await browser.close();
  }
  console.log('wrote public/icons/icon.svg, public/icons/favicon.svg');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
