import type { Request, Response } from "express";
import * as service from "./esteemed.service.js";
import type { EsteemedCategory } from "@prisma/client";

export const listAlumni = async (req: Request, res: Response) =>
  res.json(await service.listAlumni({ category: req.query.category as EsteemedCategory | undefined }));

export const createAlumnus = async (req: Request, res: Response) =>
  res.status(201).json(await service.createAlumnus(req.body));

export const updateAlumnus = async (req: Request, res: Response) =>
  res.json(await service.updateAlumnus(req.params.id, req.body));

export const deleteAlumnus = async (req: Request, res: Response) => {
  await service.deleteAlumnus(req.params.id);
  res.status(204).end();
};

export const reorderAlumni = async (req: Request, res: Response) =>
  res.json(await service.reorderAlumni(req.body.items));
