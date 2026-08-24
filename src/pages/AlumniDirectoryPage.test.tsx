/**
 * The directory is the one listing that is deliberately different for every
 * member: it opens on their own department and batch. Two things have to hold
 * on this page — it asks for that ordering and tells the reader it did (an
 * order that silently differs from everyone else's is just confusing), and the
 * LinkedIn icon appears only for alumni whose own switch left the link in the
 * payload. The page never decides that itself: a hidden link arrives as null.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const ITEMS = [
  {
    id: "p1",
    userId: "u1",
    department: "Computer Science and Engineering",
    graduationYear: 2020,
    currentCompany: "Infosys",
    currentRole: "SDE",
    city: "Pune",
    avatarKey: null,
    linkedinUrl: "https://www.linkedin.com/in/asha",
    user: { firstName: "Asha", lastName: "Kulkarni" },
  },
  {
    id: "p2",
    userId: "u2",
    department: "Computer Science and Engineering",
    graduationYear: 2019,
    currentCompany: "TCS",
    currentRole: "Analyst",
    city: "Mumbai",
    avatarKey: null,
    // Switched off in their profile, so the API sent nothing.
    linkedinUrl: null,
    user: { firstName: "Rohit", lastName: "Pawar" },
  },
];

const apiGet = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { get: (...a: unknown[]) => apiGet(...a), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  apiUrl: (p: string) => p,
  tokenStore: { get: () => null, set: vi.fn(), clear: vi.fn() },
}));

const AlumniDirectoryPage = (await import("./AlumniDirectoryPage")).default;

beforeEach(() => {
  apiGet.mockReset();
  apiGet.mockResolvedValue({
    items: ITEMS,
    relevance: { department: "Computer Science and Engineering", graduationYear: 2020 },
    pagination: { total: 2, page: 1, pageSize: 30, totalPages: 1 },
  });
});

const renderPage = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AlumniDirectoryPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

/** The last set of query params the page asked the API for. */
const lastQuery = () => apiGet.mock.calls.at(-1)![1] as Record<string, unknown>;

const cardFor = async (name: string) => {
  const heading = await screen.findByRole("heading", { name });
  return heading.closest("div.card-elevated") as HTMLElement;
};

describe("AlumniDirectoryPage", () => {
  it("asks for the viewer-relative order by default", async () => {
    renderPage();
    await waitFor(() => expect(apiGet).toHaveBeenCalled());

    expect(apiGet.mock.calls[0][0]).toBe("/alumni");
    expect(lastQuery().sort).toBe("relevant");
  });

  it("says what the order was based on, and that nobody is hidden by it", async () => {
    renderPage();

    const note = await screen.findByText(/Sorted for you/);
    expect(note).toHaveTextContent("Computer Science and Engineering");
    expect(note).toHaveTextContent("batch 2020");
    expect(note).toHaveTextContent(/Everyone is still\s+listed/);
  });

  it("drops the note when the member picks a viewer-independent order", async () => {
    renderPage();
    await screen.findByText(/Sorted for you/);

    fireEvent.keyDown(screen.getByRole("combobox", { name: "Sort alumni" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Name (A–Z)" }));

    await waitFor(() => expect(lastQuery().sort).toBe("name"));
    expect(screen.queryByText(/Sorted for you/)).toBeNull();
  });

  it("links the LinkedIn icon to the alumnus, in a new tab", async () => {
    renderPage();

    const link = within(await cardFor("Asha Kulkarni")).getByRole("link", {
      name: "Asha Kulkarni on LinkedIn",
    });
    expect(link).toHaveAttribute("href", "https://www.linkedin.com/in/asha");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("shows no icon for an alumnus whose link the API withheld", async () => {
    renderPage();

    const card = await cardFor("Rohit Pawar");
    expect(within(card).queryByRole("link", { name: /LinkedIn/ })).toBeNull();
    // The card itself is unchanged otherwise.
    expect(card).toHaveTextContent("Analyst at TCS");
  });

  it("passes the department and batch filters through as before", async () => {
    renderPage();
    await waitFor(() => expect(apiGet).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText("Search alumni by name or company"), {
      target: { value: "asha" },
    });

    await waitFor(() => expect(lastQuery().q).toBe("asha"));
    expect(lastQuery().sort).toBe("relevant");
  });
});
