import { Router } from 'express';
import { z } from 'zod';
import * as depositService from '../services/depositService';
import { positiveMoney } from './validation';

export const depositsRouter = Router();

const createDepositBody = z.object({
  memberId: z.string().uuid(),
  amount: positiveMoney,
  turnoverMultiplier: z.number().int().min(0).default(1),
});

depositsRouter.post('/', async (req, res, next) => {
  try {
    const body = createDepositBody.parse(req.body);
    const ftx = await depositService.createDeposit(body);
    res.status(201).json({
      id: ftx.id,
      status: ftx.status,
      amount: ftx.amount,
      turnoverMultiplier: ftx.turnoverMultiplier,
      pspRef: ftx.pspRef,
    });
  } catch (err) {
    next(err);
  }
});
