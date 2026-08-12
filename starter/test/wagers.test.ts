import request from 'supertest';
import { app, createMember, fundWallet, getWallet, ledgerTotals, useDatabase } from './helpers';
import { WalletTx } from '../src/db/models';
import { money } from '../src/lib/money';

useDatabase();

function wager(walletId: string, amount: string) {
  return request(app).post(`/wallets/${walletId}/wagers`).send({ amount });
}

describe('POST /wallets/:walletId/wagers', () => {
  it('debits the wallet and accrues turnover', async () => {
    const { memberId, walletId } = await createMember();
    await fundWallet(memberId, '100.00');

    const res = await wager(walletId, '10.50');

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      walletId,
      amount: money('-10.50'),
      balance: money('89.50'),
      turnoverAccrued: money('10.50'),
    });

    const wallet = await getWallet(memberId);
    expect(wallet.balance).toBe(money('89.50'));
    expect(wallet.turnoverAccrued).toBe(money('10.50'));
  });

  it('rejects a wager larger than the balance and leaves the wallet untouched', async () => {
    const { memberId, walletId } = await createMember();
    await fundWallet(memberId, '20.00');

    const res = await wager(walletId, '20.01');

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: 'insufficient_funds',
      balance: money('20.00'),
      requested: money('20.01'),
    });
    expect((await getWallet(memberId)).balance).toBe(money('20.00'));
    expect(await WalletTx.count({ where: { walletId, type: 'wager_debit' } })).toBe(0);
  });

  it('allows a wager for exactly the balance', async () => {
    const { memberId, walletId } = await createMember();
    await fundWallet(memberId, '20.00');

    const res = await wager(walletId, '20.00');

    expect(res.status).toBe(201);
    expect((await getWallet(memberId)).balance).toBe(money(0));
  });

  it('rejects a wager on an empty wallet', async () => {
    const { walletId } = await createMember();
    const res = await wager(walletId, '0.01');
    expect(res.status).toBe(422);
  });

  it('validates the amount and the wallet id', async () => {
    const { walletId } = await createMember();
    for (const amount of ['0', '-5', 'abc', 10]) {
      expect((await wager(walletId, amount as string)).status).toBe(400);
    }
    expect((await wager('not-a-uuid', '1.00')).status).toBe(400);
    expect((await wager('00000000-0000-4000-8000-000000000000', '1.00')).status).toBe(404);
  });
});

describe('concurrent wagers', () => {
  it('cannot overdraw a wallet', async () => {
    const { memberId, walletId } = await createMember();
    await fundWallet(memberId, '100.00');

    // Two wagers that each fit on their own but cannot both be honoured.
    const [a, b] = await Promise.all([wager(walletId, '60.00'), wager(walletId, '60.00')]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 422]);

    const wallet = await getWallet(memberId);
    expect(wallet.balance).toBe(money('40.00'));
    expect(wallet.turnoverAccrued).toBe(money('60.00'));
    expect(await WalletTx.count({ where: { walletId, type: 'wager_debit' } })).toBe(1);
  });

  it('settles a burst of wagers exactly, never going negative', async () => {
    const { memberId, walletId } = await createMember();
    await fundWallet(memberId, '100.00');

    // Ten wagers of 15 against a balance of 100: six can be paid, four cannot.
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => wager(walletId, '15.00')),
    );

    const accepted = responses.filter((r) => r.status === 201);
    const rejected = responses.filter((r) => r.status === 422);
    expect(accepted).toHaveLength(6);
    expect(rejected).toHaveLength(4);

    const wallet = await getWallet(memberId);
    expect(wallet.balance).toBe(money('10.00'));
    expect(wallet.turnoverAccrued).toBe(money('90.00'));

    const totals = await ledgerTotals(walletId);
    expect(totals.balance).toBe(wallet.balance);
    expect(totals.entries).toBe(7); // 1 deposit credit + 6 wager debits
  });

  it('keeps each concurrent wager on its own wallet', async () => {
    const first = await createMember();
    const second = await createMember();
    await Promise.all([fundWallet(first.memberId, '50.00'), fundWallet(second.memberId, '50.00')]);

    await Promise.all([wager(first.walletId, '30.00'), wager(second.walletId, '10.00')]);

    expect((await getWallet(first.memberId)).balance).toBe(money('20.00'));
    expect((await getWallet(second.memberId)).balance).toBe(money('40.00'));
  });
});
