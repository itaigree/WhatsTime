import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * The production build only: the built page loads nothing but its own external scripts and stylesheets. GitHub
 * Pages cannot send headers, so it goes in a meta tag (where frame-ancestors is not available).
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "manifest-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

/** Adds the CSP meta right after <meta charset> at build time; the dev server injects inline styles, so not there. */
function contentSecurityPolicy(): Plugin {
  return {
    name: 'whatstime:content-security-policy',
    apply: 'build',
    transformIndexHtml(html) {
      const charset = /<meta charset="[^"]*"\s*\/?>/i.exec(html);
      if (!charset) throw new Error('index.html needs a <meta charset> for the Content-Security-Policy to follow');
      const at = charset.index + charset[0].length;
      const meta = `\n    <meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />`;
      return html.slice(0, at) + meta + html.slice(at);
    },
  };
}

export default defineConfig({
  // Relative base so the build works on GitHub Pages project sites (/<repo>/) and at a domain root.
  base: './',
  plugins: [contentSecurityPolicy()],
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
