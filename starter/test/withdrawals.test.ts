import request from 'supertest';
import { app, createMember, fundWallet, getWallet, ledgerTotals, useDatabase } from './helpers';
import { FundingTransaction } from '../src/db/models';
import { money } from '../src/lib/money';

useDatabase();

function withdraw(memberId: string, amount: string) {
  return request(app).post('/withdrawals').send({ memberId, amount });
}

function wager(walletId: string, amount: string) {
  return request(app).post(`/wallets/${walletId}/wagers`).send({ amount });
}

describe('POST /withdrawals - the turnover lock', () => {
  it('blocks a withdrawal while turnover is outstanding, then allows it once cleared', async () => {
    const { memberId, walletId } = await createMember();
    // 100 deposited at multiplier 1 => 100 of turnover must be wagered first.
    await fundWallet(memberId, '100.00', 1);

    const blocked = await withdraw(memberId, '50.00');
    expect(blocked.status).toBe(422);
    expect(blocked.body).toMatchObject({
      error: 'turnover_requirement_not_met',
      turnoverRequired: money('100.00'),
      turnoverAccrued: money(0),
      turnoverOutstanding: money('100.00'),
    });
    expect((await getWallet(memberId)).balance).toBe(money('100.00'));

    // Wager some of it: still short.
    await wager(walletId, '60.00');
    const stillBlocked = await withdraw(memberId, '20.00');
    expect(stillBlocked.status).toBe(422);
    expect(stillBlocked.body.turnoverOutstanding).toBe(money('40.00'));

    // Clear the rest of the requirement, then top up with a multiplier-0 deposit so
    // there is something left to withdraw.
    await wager(walletId, '40.00');
    await fundWallet(memberId, '50.00', 0);

    const cleared = await getWallet(memberId);
    expect(cleared.turnoverOutstanding).toBe(money(0));

    const allowed = await withdraw(memberId, '50.00');
    expect(allowed.status).toBe(201);
    expect(allowed.body).toMatchObject({ status: 'pending', amount: money('50.00'), balance: money(0) });
  });

  it('lets a multiplier-0 deposit be withdrawn immediately', async () => {
    const { memberId } = await createMember();
    await fundWallet(memberId, '75.00', 0);

    const res = await withdraw(memberId, '75.00');

    expect(res.status).toBe(201);
    expect((await getWallet(memberId)).balance).toBe(money(0));
  });

  it('applies the multiplier to the requirement', async () => {
    const { memberId } = await createMember();
    await fundWallet(memberId, '100.00', 3);

    const wallet = await getWallet(memberId);
    expect(wallet.turnoverRequired).toBe(money('300.00'));
    expect((await withdraw(memberId, '10.00')).body.turnoverOutstanding).toBe(money('300.00'));
  });

  it('accrues turnover only from wagers, not from deposits', async () => {
    const { memberId, walletId } = await createMember();
    await fundWallet(memberId, '100.00', 1);
    await wager(walletId, '25.00');

    const wallet = await getWallet(memberId);
    expect(wallet.turnoverAccrued).toBe(money('25.00'));
    expect(wallet.turnoverOutstanding).toBe(money('75.00'));
  });
});

describe('POST /withdrawals - money movement', () => {
  it('debits immediately and files a pending funding transaction', async () => {
    const { memberId, walletId } = await createMember();
    await fundWallet(memberId, '100.00', 0);

    const res = await withdraw(memberId, '30.00');

    expect(res.status).toBe(201);
    const ftx = await FundingTransaction.findByPk(res.body.id);
    expect(ftx).toMatchObject({ type: 'withdrawal', status: 'pending', amount: money('30.00') });
    // Withdrawals are not settled through a PSP callback in this service.
    expect(ftx?.pspRef).toBeNull();

    const wallet = await getWallet(memberId);
    expect(wallet.balance).toBe(money('70.00'));

    const totals = await ledgerTotals(walletId);
    expect(totals.balance).toBe(wallet.balance);
    expect(totals.entries).toBe(2);
  });

  it('rejects a withdrawal larger than the balance', async () => {
    const { memberId } = await createMember();
    await fundWallet(memberId, '10.00', 0);

    const res = await withdraw(memberId, '10.01');

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('insufficient_funds');
    expect((await getWallet(memberId)).balance).toBe(money('10.00'));
  });

  it('cannot be raced past the balance', async () => {
    const { memberId, walletId } = await createMember();
    await fundWallet(memberId, '100.00', 0);

    const [a, b] = await Promise.all([withdraw(memberId, '80.00'), withdraw(memberId, '80.00')]);

    expect([a.status, b.status].sort()).toEqual([201, 422]);
    const wallet = await getWallet(memberId);
    expect(wallet.balance).toBe(money('20.00'));
    expect((await ledgerTotals(walletId)).balance).toBe(wallet.balance);
  });

  it('cannot be raced past the turnover lock by a concurrent wager', async () => {
    const { memberId, walletId } = await createMember();
    await fundWallet(memberId, '100.00', 1);
    await wager(walletId, '99.00');

    // The wager that clears the last unit of turnover is also the wager that spends
    // the last unit of balance, so the withdrawal has no interleaving that lets it
    // through: it either sees turnover still outstanding (it ran first) or an empty
    // wallet (it ran second). Both are a 422, and the reason tells you which happened.
    const [wagerRes, withdrawRes] = await Promise.all([
      wager(walletId, '1.00'),
      withdraw(memberId, '1.00'),
    ]);

    expect(wagerRes.status).toBe(201);
    expect(withdrawRes.status).toBe(422);
    expect(['turnover_requirement_not_met', 'insufficient_funds']).toContain(
      withdrawRes.body.error,
    );

    const wallet = await getWallet(memberId);
    expect(wallet.balance).toBe(money(0));
    expect(wallet.turnoverOutstanding).toBe(money(0));
    expect(await FundingTransaction.count({ where: { walletId, type: 'withdrawal' } })).toBe(0);
    expect((await ledgerTotals(walletId)).balance).toBe(wallet.balance);
  });

  it('validates its input', async () => {
    const { memberId } = await createMember();
    for (const amount of ['0', '-1', 'abc', 5]) {
      expect((await withdraw(memberId, amount as string)).status).toBe(400);
    }
    expect((await withdraw('not-a-uuid', '1.00')).status).toBe(400);
    expect((await withdraw('00000000-0000-4000-8000-000000000000', '1.00')).status).toBe(404);
  });
});
