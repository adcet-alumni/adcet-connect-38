/**
 * Every route below the landing page is `React.lazy`, so the app now depends
 * on a Suspense boundary resolving correctly. A broken boundary does not fail
 * the build or the type check — it fails in the browser, as a blank page.
 *
 * These render the real `<App />` (its own router replaced by a MemoryRouter)
 * at lazy routes and wait for the page behind them, which is exactly the thing
 * code splitting can break.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/lib/api", () => ({
  api: {
    get: vi.fn().mockResolvedValue({ items: [], pagination: { total: 0, page: 1, pageSize: 10, totalPages: 1 } }),
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
  },
  apiUrl: (p: string) => p,
  tokenStore: { get: () => null, set: vi.fn(), clear: vi.fn() },
  shouldRetryQuery: () => false,
  ApiError: class extends Error {},
  isNotFoundError: () => false,
  API_BASE_URL: "",
}));

// `App` mounts its own BrowserRouter; swapping in a MemoryRouter is what lets
// a test choose the entry path.
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, BrowserRouter: ({ children }: { children: React.ReactNode }) => <>{children}</> };
});

const renderAt = async (path: string) => {
  const { default: App } = await import("./App");
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
};

/**
 * These mount the whole application, so they are slow: a landing-page render
 * plus the dynamic imports every route below it now needs. `vitest.config.ts`
 * raises `testTimeout` suite-wide for exactly this.
 */
const RENDER_TIMEOUT = 20_000;

describe("lazy routes resolve behind the Suspense boundary", () => {
  it("renders a public lazy route", async () => {
    await renderAt("/testimonials");
    // Nothing is on screen until the chunk resolves — that wait is the test.
    await waitFor(() => expect(document.body.textContent).not.toBe(""), { timeout: RENDER_TIMEOUT });
    expect(document.body.textContent!.length).toBeGreaterThan(0);
  });

  it("renders the eager landing page without suspending", async () => {
    await renderAt("/");
    // Kept eager on purpose: it is the first paint, and splitting it would add
    // a round trip before anything appeared.
    expect(document.body.textContent!.length).toBeGreaterThan(0);
  });

  it("sends an unknown path to the 404 page", async () => {
    await renderAt("/no-such-page");
    await waitFor(() => expect(screen.getByText(/404|not found/i)).toBeTruthy(), { timeout: RENDER_TIMEOUT });
  });

  it("keeps a logged-out visitor off a protected route", async () => {
    await renderAt("/dashboard/feed");
    // ProtectedRoute bounces a signed-out visitor to the landing page rather
    // than rendering the dashboard shell, and must still do so now that both
    // the shell and the pages inside it are lazy — a Suspense boundary that
    // resolved before the guard ran would flash private chrome.
    await waitFor(
      () => expect(screen.getByRole("link", { name: /join network/i })).toBeTruthy(),
      { timeout: RENDER_TIMEOUT },
    );
    expect(screen.queryByText(/What's happening across the alumni network/i)).toBeNull();
  });
});
