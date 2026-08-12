import { Router } from 'express';
import { z } from 'zod';
import * as withdrawalService from '../services/withdrawalService';
import { positiveMoney } from './validation';

export const withdrawalsRouter = Router();

const createWithdrawalBody = z.object({
  memberId: z.string().uuid(),
  amount: positiveMoney,
});

withdrawalsRouter.post('/', async (req, res, next) => {
  try {
    const body = createWithdrawalBody.parse(req.body);
    const { fundingTransaction, wallet } = await withdrawalService.createWithdrawal(
      body.memberId,
      body.amount,
    );
    res.status(201).json({
      id: fundingTransaction.id,
      status: fundingTransaction.status,
      amount: fundingTransaction.amount,
      balance: wallet.balance,
    });
  } catch (err) {
    next(err);
  }
});
