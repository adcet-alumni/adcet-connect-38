import { EsteemedCategory } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { NotFound } from "../../lib/errors.js";
import { getStorage } from "../../storage/index.js";

const defaultOrder = [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }];

export const listAlumni = async (opts: { category?: EsteemedCategory } = {}) => {
  const items = await prisma.esteemedAlumnus.findMany({
    where: opts.category ? { category: opts.category } : undefined,
    orderBy: defaultOrder,
  });
  return { items };
};

export const createAlumnus = async (data: {
  name: string;
  batch: number;
  position: string;
  photoKey: string;
  category: EsteemedCategory;
  sortOrder?: number;
}) => prisma.esteemedAlumnus.create({ data });

export const updateAlumnus = async (
  id: string,
  data: {
    name?: string;
    batch?: number;
    position?: string;
    photoKey?: string;
    category?: EsteemedCategory;
    sortOrder?: number;
  },
) => {
  const existing = await prisma.esteemedAlumnus.findUnique({ where: { id } });
  if (!existing) throw NotFound("Esteemed alumnus not found");

  // Remove the old photo from storage when it is being replaced.
  if ("photoKey" in data && data.photoKey && data.photoKey !== existing.photoKey) {
    await removeObject(existing.photoKey);
  }

  return prisma.esteemedAlumnus.update({ where: { id }, data });
};

export const deleteAlumnus = async (id: string) => {
  const alumnus = await prisma.esteemedAlumnus.findUnique({ where: { id } });
  if (!alumnus) return;
  await prisma.esteemedAlumnus.delete({ where: { id } });
  await removeObject(alumnus.photoKey);
};

/**
 * Bulk reorder: accepts an array of `{ id, sortOrder }` pairs and applies them
 * atomically so the admin's drag-and-drop order is persisted in one request.
 */
export const reorderAlumni = async (items: { id: string; sortOrder: number }[]) => {
  await prisma.$transaction(
    items.map(({ id, sortOrder }) =>
      prisma.esteemedAlumnus.update({ where: { id }, data: { sortOrder } }),
    ),
  );
  return listAlumni();
};

const removeObject = async (key: string) => {
  if (key.startsWith("/")) return;
  await getStorage().delete(key).catch(() => undefined);
};
