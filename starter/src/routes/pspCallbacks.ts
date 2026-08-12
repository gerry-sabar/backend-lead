import { Router } from 'express';
import { z } from 'zod';
import * as pspCallbackService from '../services/pspCallbackService';
import { positiveMoney } from './validation';

export const pspCallbacksRouter = Router();

// Deliberately strict about shape and deliberately forgiving about repetition: a
// malformed delivery is a broken integration, a repeated one is Tuesday.
const callbackBody = z.object({
  pspRef: z.string().min(1),
  status: z.enum(['completed', 'failed']),
  amount: positiveMoney,
});

pspCallbacksRouter.post('/callbacks', async (req, res, next) => {
  try {
    const body = callbackBody.parse(req.body);
    const result = await pspCallbackService.handlePspCallback({
      pspRef: body.pspRef,
      status: body.status,
      amount: body.amount.toFixed(),
      raw: req.body,
    });
    // 200 for anything we have durably decided about, including a mismatch we
    // refused to credit: the PSP has nothing useful left to retry.
    res.status(200).json({
      pspRef: body.pspRef,
      transactionId: result.fundingTransactionId,
      status: result.status,
      outcome: result.outcome,
    });
  } catch (err) {
    next(err);
  }
});
