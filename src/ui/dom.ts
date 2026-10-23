/**
 * A tiny DOM builder. Text always becomes text nodes (never parsed as HTML),
 * so untrusted values such as contact names and messages are safe to pass.
 */

export type Child = Node | string | number | null | undefined | false;
type Handler = (event: never) => void;
export type Props = Record<string, string | number | boolean | null | undefined | Handler>;

/**
 * h('button', { type: 'button', class: 'btn', onClick: fn }, 'Label').
 * `on<Event>` props add listeners, `aria-*` booleans become "true"/"false", other `false`/null/undefined
 * props are skipped, `true` sets an empty attribute, and `value`/`checked` set the live property.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: (Child | readonly Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  append(el, children);
  if (props) setProps(el, props);
  return el;
}

export function append(parent: Node, children: readonly (Child | readonly Child[])[]): void {
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** Replace all children (same child rules as h()). */
export function setChildren(parent: Element, ...children: (Child | readonly Child[])[]): void {
  parent.replaceChildren();
  append(parent, children);
}

function setProps(el: HTMLElement, props: Props): void {
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value as unknown as EventListener);
    } else if (key.startsWith('aria-') && typeof value === 'boolean') {
      el.setAttribute(key, String(value));
    } else if (value === null || value === undefined || value === false) {
      continue;
    } else if (key === 'class') {
      el.className = String(value);
    } else if (
      key === 'value' &&
      (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)
    ) {
      el.value = String(value);
    } else if (key === 'checked' && el instanceof HTMLInputElement) {
      el.checked = value === true;
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }
}

let idCounter = 0;

/** A document-unique id for label/aria wiring. */
export function uid(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function idRefs(el: Element, attr: string): Set<string> {
  return new Set((el.getAttribute(attr) ?? '').split(/\s+/).filter(Boolean));
}

/** Add an id to a space-separated reference attribute such as aria-describedby. */
export function addIdRef(el: Element, attr: string, id: string): void {
  const ids = idRefs(el, attr);
  ids.add(id);
  el.setAttribute(attr, [...ids].join(' '));
}

export function removeIdRef(el: Element, attr: string, id: string): void {
  const ids = idRefs(el, attr);
  ids.delete(id);
  if (ids.size > 0) el.setAttribute(attr, [...ids].join(' '));
  else el.removeAttribute(attr);
}

export interface Debounced {
  (): void;
  /** Run now if a call is pending. */
  flush(): void;
  cancel(): void;
}

export function debounce(fn: () => void, ms: number): Debounced {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = (): void => {
    timer = undefined;
    fn();
  };
  const debounced = (): void => {
    clearTimeout(timer);
    timer = setTimeout(run, ms);
  };
  debounced.flush = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      run();
    }
  };
  debounced.cancel = (): void => {
    clearTimeout(timer);
    timer = undefined;
  };
  return debounced;
}

/** Sort elements into document order (for "focus the first invalid field"). */
export function inDocumentOrder<T extends Node>(nodes: readonly T[]): T[] {
  return [...nodes].sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
}
