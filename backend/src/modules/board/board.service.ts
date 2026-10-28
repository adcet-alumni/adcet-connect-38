import { prisma } from "../../lib/prisma.js";
import { NotFound } from "../../lib/errors.js";
import { getStorage } from "../../storage/index.js";

/** Order members by their explicit sort order, then by creation date for ties. */
const defaultOrder = [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }];

export const listMembers = async () => {
  const items = await prisma.boardMember.findMany({ orderBy: defaultOrder });
  return { items };
};

export const createMember = async (data: {
  name: string;
  authority: string;
  designation: string;
  photoKey?: string;
  sortOrder?: number;
}) => prisma.boardMember.create({ data });

export const updateMember = async (
  id: string,
  data: {
    name?: string;
    authority?: string;
    designation?: string;
    photoKey?: string | null;
    sortOrder?: number;
  },
) => {
  const existing = await prisma.boardMember.findUnique({ where: { id } });
  if (!existing) throw NotFound("Board member not found");

  // If the photo is being replaced/removed, clean up the old one.
  if ("photoKey" in data && data.photoKey !== existing.photoKey && existing.photoKey) {
    await removeObject(existing.photoKey);
  }

  return prisma.boardMember.update({ where: { id }, data });
};

export const deleteMember = async (id: string) => {
  const member = await prisma.boardMember.findUnique({ where: { id } });
  if (!member) return;
  await prisma.boardMember.delete({ where: { id } });
  if (member.photoKey) await removeObject(member.photoKey);
};

/**
 * Replace the entire board list in one request: accepts an ordered array of
 * `{ id, sortOrder }` pairs and updates each member's position atomically.
 */
export const reorderMembers = async (items: { id: string; sortOrder: number }[]) => {
  await prisma.$transaction(
    items.map(({ id, sortOrder }) =>
      prisma.boardMember.update({ where: { id }, data: { sortOrder } }),
    ),
  );
  return listMembers();
};

/** Never try to delete objects that live under `public/` (legacy/seeded paths). */
const removeObject = async (key: string) => {
  if (key.startsWith("/")) return;
  await getStorage().delete(key).catch(() => undefined);
};
