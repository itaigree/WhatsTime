/** Hash routes: '#/' compose, '#/done/<id>' result, '#/scheduled', '#/settings'. */

export type Route = { name: 'compose' } | { name: 'done'; id: string } | { name: 'scheduled' } | { name: 'settings' };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '');
  if (path === '/scheduled') return { name: 'scheduled' };
  if (path === '/settings') return { name: 'settings' };
  const done = /^\/done\/([^/?#]+)$/.exec(path);
  if (done?.[1]) {
    try {
      return { name: 'done', id: decodeURIComponent(done[1]) };
    } catch {
      return { name: 'compose' };
    }
  }
  return { name: 'compose' };
}

export function doneHref(id: string): string {
  return `#/done/${encodeURIComponent(id)}`;
}
