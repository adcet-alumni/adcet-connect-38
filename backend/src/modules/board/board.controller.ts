import type { Request, Response } from "express";
import * as service from "./board.service.js";

export const listMembers = async (_req: Request, res: Response) =>
  res.json(await service.listMembers());

export const createMember = async (req: Request, res: Response) =>
  res.status(201).json(await service.createMember(req.body));

export const updateMember = async (req: Request, res: Response) =>
  res.json(await service.updateMember(req.params.id, req.body));

export const deleteMember = async (req: Request, res: Response) => {
  await service.deleteMember(req.params.id);
  res.status(204).end();
};

export const reorderMembers = async (req: Request, res: Response) =>
  res.json(await service.reorderMembers(req.body.items));
