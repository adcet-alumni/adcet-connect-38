/**
 * The confirm button awaits the caller's mutation. Every caller passes a
 * TanStack `mutateAsync`, which rejects on failure *after* its own `onError`
 * has toasted — so a rejection reaching this button is expected, not
 * exceptional. What must hold: it never escapes as an unhandled rejection, and
 * a failed rejection leaves the dialog open with the reason still typed in, so
 * the admin can retry rather than reopen and retype.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import RejectReasonDialog from "./RejectReasonDialog";

const setup = (onConfirm: (reason: string) => Promise<unknown>) => {
  const onOpenChange = vi.fn();
  render(
    <RejectReasonDialog
      open
      onOpenChange={onOpenChange}
      title="Reject request"
      onConfirm={onConfirm}
    />,
  );
  return { onOpenChange };
};

const reject = () => fireEvent.click(screen.getByRole("button", { name: "Reject" }));

describe("RejectReasonDialog", () => {
  it("closes once the confirm resolves", async () => {
    const { onOpenChange } = setup(vi.fn().mockResolvedValue(undefined));

    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "Not this term" } });
    reject();

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("stays open and swallows the rejection when the confirm fails", async () => {
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    const onConfirm = vi.fn().mockRejectedValue(new Error("Network error"));
    const { onOpenChange } = setup(onConfirm);

    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "Incomplete" } });
    reject();

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith("Incomplete"));
    expect(onOpenChange).not.toHaveBeenCalled();
    // The typed reason survives for the retry.
    expect(screen.getByLabelText(/Reason/)).toHaveValue("Incomplete");
    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandled);
  });
});
