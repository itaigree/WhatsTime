/** App shell: tabs, routing between views, focus management and the status toast. */

import { createStore } from '../core/storage';
import { defaultSettings, safeLocalStorage } from './context';
import type { AppContext, View } from './context';
import { h } from './dom';
import { parseRoute } from './router';
import type { Route } from './router';
import { composeView } from './views/compose';
import { resultView } from './views/result';
import { scheduledView } from './views/scheduled';
import { settingsView } from './views/settings';

const TOAST_MS = 2500;
const SVG_NS = 'http://www.w3.org/2000/svg';

function required<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing ${selector} in index.html`);
  return el;
}

function createView(route: Route, ctx: AppContext): View {
  switch (route.name) {
    case 'done':
      return resultView(ctx, route.id);
    case 'scheduled':
      return scheduledView(ctx);
    case 'settings':
      return settingsView(ctx);
    case 'compose':
      return composeView(ctx);
  }
}

function svgElement(tag: string, attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

/** Shown instead of a view that failed to render, so the app never ends up blank. */
function errorView(): View {
  const heading = h('h1', { tabindex: -1 }, 'Something went wrong');
  const element = h(
    'div',
    { class: 'view' },
    heading,
    h(
      'section',
      { class: 'card empty' },
      h('p', null, 'This page could not be shown. Your saved reminders are still on this device.'),
      h('button', { type: 'button', class: 'btn btn-primary', onClick: () => window.location.reload() }, 'Reload'),
    ),
  );
  return { title: 'Error', element, heading };
}

function safeView(route: Route, ctx: AppContext): View {
  try {
    return createView(route, ctx);
  } catch (error) {
    console.error(error);
    return errorView();
  }
}

/** The app mark (speech bubble with a clock); colours come from CSS so it suits the app bar. */
function brandMark(): SVGElement {
  const svg = svgElement('svg', { viewBox: '0 0 512 512', 'aria-hidden': 'true', focusable: 'false' });
  const group = svgElement('g', { transform: 'translate(-4 10)' });
  group.append(
    svgElement('path', {
      class: 'brand-bubble',
      d: 'M176 80H336A104 104 0 0 1 440 184V316C440 352 446 386 462 414C428 410 396 398 372 380C360 383 348 384 336 384H176A104 104 0 0 1 72 280V184A104 104 0 0 1 176 80Z',
    }),
    svgElement('circle', { class: 'brand-hand', cx: '256', cy: '232', r: '100', 'stroke-width': '44' }),
    svgElement('path', {
      class: 'brand-hand',
      d: 'M256 232V176M256 232L294 254',
      'stroke-width': '40',
      'stroke-linecap': 'round',
    }),
  );
  svg.append(svgElement('rect', { class: 'brand-tile', width: '512', height: '512', rx: '112' }), group);
  return svg;
}

export function startApp(options: { sharedText: string | null }): void {
  const main = required<HTMLElement>('#main');
  const toast = required<HTMLElement>('.toast');
  const tabs = [...document.querySelectorAll<HTMLAnchorElement>('[data-tab]')];
  document.querySelector('.brand-mark')?.appendChild(brandMark());

  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const announce = (message: string): void => {
    clearTimeout(toastTimer);
    toast.textContent = '';
    toast.classList.remove('show');
    // A fresh text node in a new frame makes screen readers announce repeated messages too.
    requestAnimationFrame(() => {
      toast.textContent = message;
      toast.classList.add('show');
    });
    toastTimer = setTimeout(() => {
      toast.classList.remove('show');
      // Clear once faded out, so stale text is not found later when reading the page.
      toastTimer = setTimeout(() => (toast.textContent = ''), 300);
    }, TOAST_MS);
  };

  const store = createStore(safeLocalStorage());
  const ctx: AppContext = {
    store,
    settings: store.loadSettings(defaultSettings()),
    saveSettings(next) {
      ctx.settings = next;
      store.saveSettings(next);
    },
    prefill: null,
    lastCreated: null,
    notice: null,
    navigate(hash) {
      if (window.location.hash === hash) render(true);
      else window.location.hash = hash;
    },
    announce,
  };

  if (options.sharedText !== null) {
    ctx.prefill = { ...(store.loadDraft() ?? {}), message: options.sharedText };
  }

  let current: View | null = null;

  function render(moveFocus: boolean): void {
    current?.destroy?.();
    const route = parseRoute(window.location.hash);
    const view = safeView(route, ctx);
    current = view;
    main.replaceChildren(view.element);
    for (const tab of tabs) {
      if (tab.dataset.tab === route.name) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    }
    document.title = `${view.title} · WhatsTime`;
    view.mounted?.();
    if (moveFocus) {
      window.scrollTo(0, 0);
      view.heading.focus({ preventScroll: true });
    }
  }

  window.addEventListener('hashchange', () => render(true));
  render(false);
}
