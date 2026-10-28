/**
 * Esteemed alumni — DB-backed, admin-managed.
 *
 * The admin adds, edits and reorders members from `/admin/esteemed`.
 * Photos are stored in S3 (via the `esteemed-alumni` upload scope);
 * `assetUrl()` resolves the key to a browsable URL.
 *
 * The DB category column uses underscores (`civil_services`) to satisfy
 * PostgreSQL enum naming rules; the frontend maps these to the display ids
 * ("civil-services") used in URLs and UI labels.
 */
import { api } from "@/lib/api";
import { assetUrl } from "@/lib/storage";

/** DB enum value — must match the Prisma `EsteemedCategory` enum. */
export type EsteemedCategoryDb = "leadership" | "entrepreneurs" | "civil_services";

/** UI/URL-friendly id used in page anchors and route params. */
export type EsteemedCategoryId = "leadership" | "entrepreneurs" | "civil-services";

export interface EsteemedCategory {
  id: EsteemedCategoryId;
  /** DB enum value for this category. */
  dbValue: EsteemedCategoryDb;
  title: string;
  description: string;
}

export const ESTEEMED_CATEGORIES: EsteemedCategory[] = [
  {
    id: "leadership",
    dbValue: "leadership",
    title: "Leaders in Industry & Academia",
    description:
      "Alumni holding senior leadership positions across corporations, research organisations and institutions in India and abroad.",
  },
  {
    id: "entrepreneurs",
    dbValue: "entrepreneurs",
    title: "Entrepreneurs & Innovators",
    description:
      "Founders and job creators who have built companies, products and ventures out of an idea they carried from campus.",
  },
  {
    id: "civil-services",
    dbValue: "civil_services",
    title: "Civil Services & Public Administration",
    description:
      "Alumni serving the nation through the civil services, defence, public sector undertakings and government administration.",
  },
];

export interface EsteemedAlumnus {
  id: string;
  name: string;
  /** Graduating year shown under the name. */
  batch: number;
  /** Current designation — the last line on the tile. */
  position: string;
  /** Storage key for the portrait. */
  photoKey: string;
  category: EsteemedCategoryDb;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** Public URL for an esteemed alumnus portrait. */
export const esteemedAlumnusPhotoUrl = (a: EsteemedAlumnus) => assetUrl(a.photoKey);

/** Map DB enum → UI category id (e.g. `civil_services` → `civil-services`). */
export const categoryIdOf = (dbValue: EsteemedCategoryDb): EsteemedCategoryId =>
  dbValue === "civil_services" ? "civil-services" : dbValue;

/* ----------------------------- API wrappers ----------------------------- */

export const esteemedAlumniQuery = (opts: { category?: EsteemedCategoryDb } = {}) => ({
  queryKey: ["esteemed", "alumni", opts.category ?? "all"] as const,
  queryFn: () =>
    api
      .get<{ items: EsteemedAlumnus[] }>(
        "/esteemed",
        opts.category ? { category: opts.category } : undefined,
      )
      .then((r) => r.items),
});

export const createEsteemedAlumnus = (data: {
  name: string;
  batch: number;
  position: string;
  photoKey: string;
  category: EsteemedCategoryDb;
  sortOrder?: number;
}) => api.post<EsteemedAlumnus>("/esteemed", data);

export const updateEsteemedAlumnus = (
  id: string,
  data: {
    name?: string;
    batch?: number;
    position?: string;
    photoKey?: string;
    category?: EsteemedCategoryDb;
    sortOrder?: number;
  },
) => api.patch<EsteemedAlumnus>(`/esteemed/${id}`, data);

export const deleteEsteemedAlumnus = (id: string) => api.delete(`/esteemed/${id}`);

export const reorderEsteemedAlumni = (items: { id: string; sortOrder: number }[]) =>
  api.post<{ items: EsteemedAlumnus[] }>("/esteemed/reorder", { items });
