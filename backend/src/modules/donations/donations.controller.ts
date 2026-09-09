import type { Request, Response } from "express";
import * as service from "./donations.service.js";

export const listCampaigns = async (req: Request, res: Response) =>
  res.json(await service.listCampaigns(req.query as unknown as Parameters<typeof service.listCampaigns>[0]));
export const getCampaign = async (req: Request, res: Response) =>
  res.json(await service.getCampaign(req.params.id));
export const createCampaign = async (req: Request, res: Response) =>
  res.status(201).json(await service.createCampaign(req.body));
export const updateCampaign = async (req: Request, res: Response) =>
  res.json(await service.updateCampaign(req.params.id, req.body));
export const deleteCampaign = async (req: Request, res: Response) => {
  await service.deleteCampaign(req.params.id);
  res.status(204).end();
};
/** Where to pay — the QR, UPI ID and bank account the office publishes. */
export const paymentDetails = async (_req: Request, res: Response) =>
  res.json(await service.paymentDetails());
export const submit = async (req: Request, res: Response) =>
  res.status(201).json(await service.submit(req.auth!.sub, req.body));
export const approve = async (req: Request, res: Response) =>
  res.json(await service.approve(req.auth!.sub, req.params.id, req.body?.note));
export const reject = async (req: Request, res: Response) =>
  res.json(await service.reject(req.auth!.sub, req.params.id, req.body.reason));
export const cancelOwn = async (req: Request, res: Response) =>
  res.json(await service.cancelOwn(req.auth!.sub, req.params.id));
/** Public honour roll for the landing page — no session, no donor emails. */
export const topDonors = async (req: Request, res: Response) => {
  const { limit } = req.query as unknown as { limit: number };
  res.json({ items: await service.topDonorsCached(limit) });
};
export const listDonations = async (req: Request, res: Response) =>
  res.json(await service.listDonations(req.query as unknown as Parameters<typeof service.listDonations>[0]));
/** Totals for the ledger's header cards — same filters, computed in SQL. */
export const donationStats = async (req: Request, res: Response) =>
  res.json(await service.stats(req.query as unknown as Parameters<typeof service.stats>[0]));
export const myDonations = async (req: Request, res: Response) =>
  res.json(await service.myDonations(req.auth!.sub));
