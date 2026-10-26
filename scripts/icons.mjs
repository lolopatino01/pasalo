// Genera los íconos PNG a partir de public/icons/logo.svg (usa Playwright).
import { chromium } from 'playwright';
import fs from 'node:fs';

const svg = fs.readFileSync('public/icons/logo.svg', 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage();
async function render(size, file, { maskable = false, bg = 'transparent' } = {}) {
  const inner = maskable
    ? svg.replace('rx="15"', 'rx="0"').replace('r="16"', 'r="12"').replace('M32 16a16 16 0 1 1-16 16', 'M32 20a12 12 0 1 1-12 12').replaceAll('stroke-width="7"', 'stroke-width="5.5"').replace('r="4.5"', 'r="3.5"')
    : svg;
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:${bg}">${inner.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: file, omitBackground: bg === 'transparent' });
}
await render(192, 'public/icons/icon-192.png');
await render(512, 'public/icons/icon-512.png');
await render(512, 'public/icons/maskable-512.png', { maskable: true });
await render(180, 'public/icons/apple-touch-icon.png', { bg: '#2F4BFF' });
await render(32, 'public/favicon.png');
await browser.close();
console.log('íconos listos');
