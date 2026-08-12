import request from 'supertest';
import { createApp } from '../src/app';
import { sequelize } from '../src/db/sequelize';
import '../src/db/models';

export const app = createApp();

let usernameCounter = 0;

/** Standard lifecycle for a suite that touches the database. */
export function useDatabase(): void {
  beforeAll(async () => {
    await sequelize.authenticate();
  });

  beforeEach(async () => {
    await sequelize.truncate({ cascade: true });
  });

  afterAll(async () => {
    await sequelize.close();
  });
}

export interface TestMember {
  memberId: string;
  walletId: string;
}

export async function createMember(): Promise<TestMember> {
  usernameCounter += 1;
  const res = await request(app)
    .post('/members')
    .send({ username: `member${usernameCounter.toString().padStart(4, '0')}` });
  expect(res.status).toBe(201);
  return { memberId: res.body.member.id, walletId: res.body.wallet.id };
}

export async function createDeposit(
  memberId: string,
  amount: string,
  turnoverMultiplier?: number,
): Promise<{ id: string; pspRef: string }> {
  const body: Record<string, unknown> = { memberId, amount };
  if (turnoverMultiplier !== undefined) {
    body.turnoverMultiplier = turnoverMultiplier;
  }
  const res = await request(app).post('/deposits').send(body);
  expect(res.status).toBe(201);
  return { id: res.body.id, pspRef: res.body.pspRef };
}

export function sendCallback(pspRef: string, status: 'completed' | 'failed', amount: string) {
  return request(app).post('/psp/callbacks').send({ pspRef, status, amount });
}

/** Deposit and settle it, i.e. get money into a wallet. */
export async function fundWallet(
  memberId: string,
  amount: string,
  turnoverMultiplier = 0,
): Promise<void> {
  const { pspRef } = await createDeposit(memberId, amount, turnoverMultiplier);
  const res = await sendCallback(pspRef, 'completed', amount);
  expect(res.status).toBe(200);
}

export async function getWallet(memberId: string) {
  const res = await request(app).get(`/members/${memberId}/wallet`);
  expect(res.status).toBe(200);
  return res.body as {
    id: string;
    balance: string;
    turnoverRequired: string;
    turnoverAccrued: string;
    turnoverOutstanding: string;
  };
}

/** Sums the ledger directly in SQL: the balance must always be reproducible from it. */
export async function ledgerTotals(walletId: string) {
  const [rows] = await sequelize.query(
    `SELECT COALESCE(SUM(amount), 0)::text AS balance,
            COALESCE(SUM(turnover_required_delta), 0)::text AS turnover_required,
            COALESCE(SUM(turnover_accrued_delta), 0)::text AS turnover_accrued,
            COUNT(*)::int AS entries
       FROM wallet_txs
      WHERE wallet_id = :walletId`,
    { replacements: { walletId } },
  );
  return rows[0] as {
    balance: string;
    turnover_required: string;
    turnover_accrued: string;
    entries: number;
  };
}
