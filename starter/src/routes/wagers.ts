import { Router } from 'express';
import { z } from 'zod';
import * as wagerService from '../services/wagerService';
import { turnoverOutstanding } from '../services/ledgerService';
import { money } from '../lib/money';
import { positiveMoney } from './validation';

export const walletsRouter = Router();

const walletParams = z.object({ walletId: z.string().uuid() });
const createWagerBody = z.object({ amount: positiveMoney });

walletsRouter.post('/:walletId/wagers', async (req, res, next) => {
  try {
    const { walletId } = walletParams.parse(req.params);
    const { amount } = createWagerBody.parse(req.body);

    const { walletTx, wallet } = await wagerService.recordWager(walletId, amount);

    res.status(201).json({
      id: walletTx.id,
      walletId: wallet.id,
      amount: walletTx.amount,
      balance: wallet.balance,
      turnoverAccrued: wallet.turnoverAccrued,
      turnoverOutstanding: money(turnoverOutstanding(wallet)),
    });
  } catch (err) {
    next(err);
  }
});
