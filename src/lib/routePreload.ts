/**
 * Warming the route chunks before they are needed.
 *
 * Splitting the bundle by route (OPTIMIZATION.md, P1-4) took the landing page
 * from 2.26 MB of JavaScript to 640 kB, and it is not being undone here. But it
 * moved a cost rather than removing one: the *first* visit to a section now
 * waits on a network round trip for that section's chunk, which is why the
 * portal felt heavy the first time you opened Profile, Feed, Analytics or the
 * map and smooth every time after — the second visit is a cache hit.
 *
 * This module removes the wait instead of the split. Every lazy route registers
 * its import thunk here, and something warms it before the click:
 *
 *  - **On idle**, once a layout has mounted: a member in the dashboard shell
 *    will navigate inside it, so its pages are fetched during the pause after
 *    first paint rather than during the click.
 *  - **On hover or keyboard focus** of a nav link: intent, ~200 ms ahead of the
 *    click, which covers anything idle time hasn't reached yet.
 *
 * A thunk is called at most once — the second call would be free anyway, since
 * the bundler caches the module promise, but the `warmed` set also keeps the
 * idle queue from re-walking work it has already done.
 */

type Loader = () => Promise<unknown>;

/** Registered route path → the chunk behind it. */
const loaders = new Map<string, Loader>();
const warmed = new Set<Loader>();

/**
 * Record the chunk that serves `path`, and hand the thunk back so the caller
 * can pass it straight to `React.lazy`.
 */
export const registerRoute = <T>(path: string, load: () => Promise<T>): (() => Promise<T>) => {
  loaders.set(path, load as Loader);
  return load;
};

const warm = (load: Loader | undefined): void => {
  if (!load || warmed.has(load)) return;
  warmed.add(load);
  // A prefetch that fails is not an error the user should ever hear about: the
  // real navigation will retry the same import and surface it properly.
  void load().catch(() => warmed.delete(load));
};

/**
 * Fetch the chunk for `path` now.
 *
 * Falls back to the longest registered path that is a prefix of it, so a link
 * to `/dashboard/jobs/abc123` still warms the `/dashboard/jobs/:id` chunk.
 */
export const preloadRoute = (path: string): void => {
  const exact = loaders.get(path);
  if (exact) return warm(exact);

  let best: { length: number; load: Loader } | null = null;
  for (const [registered, load] of loaders) {
    if (!path.startsWith(registered)) continue;
    if (!best || registered.length > best.length) best = { length: registered.length, load };
  }
  warm(best?.load);
};

/**
 * Fetch every chunk whose route sits under `prefix`, spread across idle time.
 *
 * Chunks go one at a time: they are fetched *because* nothing else is
 * happening, and firing twenty requests at once would compete with the data the
 * page on screen is still loading. Returns a cancel function — a layout that
 * unmounts mid-walk (a sign-out, say) stops the queue.
 */
export const preloadGroup = (prefix: string): (() => void) => {
  const pending = [...loaders.entries()]
    .filter(([path]) => path.startsWith(prefix))
    .map(([, load]) => load)
    .filter((load) => !warmed.has(load));

  let cancelled = false;
  let handle: number | undefined;

  const step = () => {
    if (cancelled) return;
    const next = pending.shift();
    if (!next) return;
    warm(next);
    handle = requestIdle(step);
  };
  handle = requestIdle(step);

  return () => {
    cancelled = true;
    cancelIdle(handle);
  };
};

/*
 * `requestIdleCallback` is unimplemented in Safari before 17 and in jsdom, so
 * both are shimmed onto a timeout. The point of the shim is only that the work
 * happens *after* the current paint, not that it is scheduled precisely.
 */
type IdleWindow = Window &
  typeof globalThis & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };

const requestIdle = (cb: () => void): number => {
  const w = window as IdleWindow;
  return w.requestIdleCallback
    ? w.requestIdleCallback(cb, { timeout: 2000 })
    : window.setTimeout(cb, 200);
};

const cancelIdle = (handle: number | undefined): void => {
  if (handle === undefined) return;
  const w = window as IdleWindow;
  if (w.cancelIdleCallback) w.cancelIdleCallback(handle);
  else window.clearTimeout(handle);
};
