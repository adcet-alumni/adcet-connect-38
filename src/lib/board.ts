/**
 * Alumni Association board members — DB-backed, admin-managed.
 *
 * The admin adds, edits and reorders members from `/admin/board`.
 * Photos are stored in S3 (or whichever STORAGE_DRIVER is configured);
 * `assetUrl()` resolves the key to a browsable URL for the UI.
 */
import { api } from "@/lib/api";
import { assetUrl } from "@/lib/storage";

export interface BoardMember {
  id: string;
  name: string;
  /** Position held on the association board, e.g. "President". */
  authority: string;
  /** Institutional role, e.g. "Director, ADCET, Ashta". */
  designation: string;
  /** Storage key for the portrait, or null when no photo is on file. */
  photoKey: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** Public URL for a board member portrait, or undefined when none is set. */
export const boardMemberPhotoUrl = (member: BoardMember) =>
  member.photoKey ? assetUrl(member.photoKey) : undefined;

/** Initials used when a member has no photograph on file. */
export const initialsOf = (name: string) =>
  name
    .replace(/^(Adv\.|Dr\.|Mr\.|Mrs\.|Ms\.)\s*/i, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

/* ----------------------------- API wrappers ----------------------------- */

export const boardMembersQuery = () => ({
  queryKey: ["board", "members"] as const,
  queryFn: () =>
    api.get<{ items: BoardMember[] }>("/board").then((r) => r.items),
});

export const createBoardMember = (data: {
  name: string;
  authority: string;
  designation: string;
  photoKey?: string;
  sortOrder?: number;
}) => api.post<BoardMember>("/board", data);

export const updateBoardMember = (
  id: string,
  data: {
    name?: string;
    authority?: string;
    designation?: string;
    photoKey?: string | null;
    sortOrder?: number;
  },
) => api.patch<BoardMember>(`/board/${id}`, data);

export const deleteBoardMember = (id: string) => api.delete(`/board/${id}`);

export const reorderBoardMembers = (items: { id: string; sortOrder: number }[]) =>
  api.post<{ items: BoardMember[] }>("/board/reorder", { items });

/**
 * The alumni office's point of contact, shown on the public Contact page.
 * This is kept as a static fallback; the admin can update the board member
 * record that corresponds to this person to change photos or designation.
 */
export const ALUMNI_CELL_INCHARGE = {
  name: "Dr. Rahul R. Gaji",
  designation: "Dean, Alumni Relation and Strategic Partnership",
};

