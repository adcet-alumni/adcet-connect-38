import type { Request, Response } from "express";
import * as service from "./alumni.service.js";

/**
 * The default ordering depends on who is asking, so the caller's own
 * department and batch are read here and passed in — never taken from the
 * query string, where a member could point the "relevance" at someone else.
 */
export const search = async (req: Request, res: Response) => {
  const viewer = await service.viewerFor(req.auth!.sub);
  res.json(await service.search(req.query as unknown as service.DirectoryQuery, viewer));
};
