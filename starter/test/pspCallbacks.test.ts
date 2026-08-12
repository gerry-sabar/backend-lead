import request from 'supertest';
import {
  app,
  createDeposit,
  createMember,
  getWallet,
  ledgerTotals,
  sendCallback,
  useDatabase,
} from './helpers';
import { sequelize } from '../src/db/sequelize';
import { FundingTransaction, PspCallback, WalletTx } from '../src/db/models';
import { money } from '../src/lib/money';

useDatabase();

async function creditEntryCount(walletId: string): Promise<number> {
  return WalletTx.count({ where: { walletId, type: 'deposit_credit' } });
}

describe('POST /psp/callbacks - happy path', () => {
  it('credits the wallet once and completes the transaction', async () => {
    const { memberId, walletId } = await createMember();
    const { id, pspRef } = await createDeposit(memberId, '100.50', 2);

    const res = await sendCallback(pspRef, 'completed', '100.50');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ transactionId: id, status: 'completed', outcome: 'applied' });

    const wallet = await getWallet(memberId);
    expect(wallet.balance).toBe(money('100.50'));
    // turnover requirement = amount x multiplier
    expect(wallet.turnoverRequired).toBe(money('201.00'));
    expect(await creditEntryCount(walletId)).toBe(1);
  });

  it('records a failed payment without touching the balance', async () => {
    const { memberId, walletId } = await createMember();
    const { pspRef } = await createDeposit(memberId, '100.00');

    const res = await sendCallback(pspRef, 'failed', '100.00');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'failed', outcome: 'applied' });
    expect((await getWallet(memberId)).balance).toBe(money(0));
    expect(await creditEntryCount(walletId)).toBe(0);
  });
});

describe('POST /psp/callbacks - duplicate delivery', () => {
  it('does not double-credit when the same callback arrives twice in sequence', async () => {
    const { memberId, walletId } = await createMember();
    const { pspRef } = await createDeposit(memberId, '100.00', 1);

    const first = await sendCallback(pspRef, 'completed', '100.00');
    const second = await sendCallback(pspRef, 'completed', '100.00');

    expect(first.body.outcome).toBe('applied');
    // The retry is acknowledged, not rejected: PSPs retry for hours and a 4xx would
    // only make them retry harder.
    expect(second.status).toBe(200);
    expect(second.body.outcome).toBe('duplicate_ignored');

    const wallet = await getWallet(memberId);
    expect(wallet.balance).toBe(money('100.00'));
    expect(wallet.turnoverRequired).toBe(money('100.00'));
    expect(await creditEntryCount(walletId)).toBe(1);
  });

  it('does not double-credit a delivery that arrives much later', async () => {
    const { memberId, walletId } = await createMember();
    const { pspRef } = await createDeposit(memberId, '40.00', 0);

    await sendCallback(pspRef, 'completed', '40.00');
    // ...member plays in the meantime, so the balance has moved on.
    await request(app).post(`/wallets/${walletId}/wagers`).send({ amount: '15.00' });
    const late = await sendCallback(pspRef, 'completed', '40.00');

    expect(late.status).toBe(200);
    expect(late.body.outcome).toBe('duplicate_ignored');
    expect((await getWallet(memberId)).balance).toBe(money('25.00'));
    expect(await creditEntryCount(walletId)).toBe(1);
  });

  it('ignores a repeated failed callback', async () => {
    const { memberId } = await createMember();
    const { pspRef } = await createDeposit(memberId, '10.00');

    await sendCallback(pspRef, 'failed', '10.00');
    const second = await sendCallback(pspRef, 'failed', '10.00');

    expect(second.status).toBe(200);
    expect(second.body.outcome).toBe('duplicate_ignored');
    expect((await getWallet(memberId)).balance).toBe(money(0));
  });

  it('does not double-credit when duplicates arrive concurrently', async () => {
    const { memberId, walletId } = await createMember();
    const { pspRef } = await createDeposit(memberId, '100.00', 1);

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => sendCallback(pspRef, 'completed', '100.00')),
    );

    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    // Exactly one delivery moved money; the rest lost the race for the row lock and
    // found the transaction already settled.
    expect(responses.filter((r) => r.body.outcome === 'applied')).toHaveLength(1);
    expect(responses.filter((r) => r.body.outcome === 'duplicate_ignored')).toHaveLength(4);

    const wallet = await getWallet(memberId);
    expect(wallet.balance).toBe(money('100.00'));
    expect(wallet.turnoverRequired).toBe(money('100.00'));
    expect(await creditEntryCount(walletId)).toBe(1);
  });

  it('settles exactly one credit per deposit when several deposits settle at once', async () => {
    const { memberId, walletId } = await createMember();
    const deposits = await Promise.all([
      createDeposit(memberId, '10.00', 0),
      createDeposit(memberId, '20.00', 0),
      createDeposit(memberId, '30.00', 0),
    ]);

    // Each deposit delivered twice, all six in flight together.
    await Promise.all(
      deposits.flatMap((d, i) => [
        sendCallback(d.pspRef, 'completed', ['10.00', '20.00', '30.00'][i]),
        sendCallback(d.pspRef, 'completed', ['10.00', '20.00', '30.00'][i]),
      ]),
    );

    expect((await getWallet(memberId)).balance).toBe(money('60.00'));
    expect(await creditEntryCount(walletId)).toBe(3);
  });
});

describe('POST /psp/callbacks - hostile input', () => {
  it('404s an unknown pspRef but still records the delivery', async () => {
    const res = await sendCallback('psp_does-not-exist', 'completed', '10.00');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unknown_psp_ref');

    const receipt = await PspCallback.findOne({ where: { pspRef: 'psp_does-not-exist' } });
    expect(receipt?.outcome).toBe('unknown_ref');
  });

  it('refuses to credit when the callback amount disagrees with the deposit', async () => {
    const { memberId, walletId } = await createMember();
    const { pspRef } = await createDeposit(memberId, '100.00', 1);

    const res = await sendCallback(pspRef, 'completed', '900.00');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'disputed', outcome: 'amount_mismatch' });
    expect((await getWallet(memberId)).balance).toBe(money(0));
    expect(await creditEntryCount(walletId)).toBe(0);

    // What the PSP claimed is kept for whoever picks up the dispute.
    const ftx = await FundingTransaction.findOne({ where: { pspRef } });
    expect(ftx?.settledAmount).toBe(money('900.00'));
    expect(ftx?.statusReason).toBe('amount_mismatch');
  });

  it('does not credit a disputed deposit when the same bad delivery is retried', async () => {
    const { memberId, walletId } = await createMember();
    const { pspRef } = await createDeposit(memberId, '100.00', 1);

    await sendCallback(pspRef, 'completed', '900.00');
    const retry = await sendCallback(pspRef, 'completed', '900.00');

    expect(retry.status).toBe(200);
    expect(retry.body.outcome).toBe('duplicate_ignored');
    expect((await getWallet(memberId)).balance).toBe(money(0));
    expect(await creditEntryCount(walletId)).toBe(0);
  });

  it('rejects a completed callback after the deposit already failed', async () => {
    const { memberId, walletId } = await createMember();
    const { pspRef } = await createDeposit(memberId, '100.00');

    await sendCallback(pspRef, 'failed', '100.00');
    const res = await sendCallback(pspRef, 'completed', '100.00');

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('invalid_state_transition');
    expect((await getWallet(memberId)).balance).toBe(money(0));
    expect(await creditEntryCount(walletId)).toBe(0);
  });

  it('rejects a failed callback after the deposit already completed', async () => {
    const { memberId } = await createMember();
    const { pspRef } = await createDeposit(memberId, '100.00', 0);

    await sendCallback(pspRef, 'completed', '100.00');
    const res = await sendCallback(pspRef, 'failed', '100.00');

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('invalid_state_transition');
    // The credit stands: a late failure does not claw money back silently.
    expect((await getWallet(memberId)).balance).toBe(money('100.00'));
  });

  it('rejects a settled deposit being re-reported with a different amount', async () => {
    const { memberId, walletId } = await createMember();
    const { pspRef } = await createDeposit(memberId, '100.00', 0);

    await sendCallback(pspRef, 'completed', '100.00');
    const res = await sendCallback(pspRef, 'completed', '250.00');

    expect(res.status).toBe(409);
    expect((await getWallet(memberId)).balance).toBe(money('100.00'));
    expect(await creditEntryCount(walletId)).toBe(1);
  });

  it('rejects malformed deliveries', async () => {
    const { memberId } = await createMember();
    const { pspRef } = await createDeposit(memberId, '10.00');

    const cases = [
      { pspRef, status: 'pending', amount: '10.00' },
      { pspRef, status: 'completed', amount: -10 },
      { pspRef, amount: '10.00' },
      { status: 'completed', amount: '10.00' },
    ];
    for (const body of cases) {
      const res = await request(app).post('/psp/callbacks').send(body);
      expect([body, res.status]).toEqual([body, 400]);
    }
    expect((await getWallet(memberId)).balance).toBe(money(0));
  });

  it('logs every delivery, including the ones it refuses', async () => {
    const { memberId } = await createMember();
    const { pspRef } = await createDeposit(memberId, '100.00', 0);

    await sendCallback(pspRef, 'completed', '100.00');
    await sendCallback(pspRef, 'completed', '100.00');
    await sendCallback(pspRef, 'failed', '100.00');

    const receipts = await PspCallback.findAll({ where: { pspRef }, order: [['createdAt', 'ASC']] });
    expect(receipts.map((r) => r.outcome)).toEqual([
      'applied',
      'duplicate_ignored',
      'invalid_transition',
    ]);
  });
});

describe('the ledger is the source of truth', () => {
  it('never leaves the balance out of step with the ledger', async () => {
    const { memberId, walletId } = await createMember();
    const { pspRef } = await createDeposit(memberId, '100.00', 1);
    await sendCallback(pspRef, 'completed', '100.00');
    await request(app).post(`/wallets/${walletId}/wagers`).send({ amount: '30.00' });

    const wallet = await getWallet(memberId);
    const totals = await ledgerTotals(walletId);

    expect(totals.balance).toBe(wallet.balance);
    expect(totals.turnover_required).toBe(wallet.turnoverRequired);
    expect(totals.turnover_accrued).toBe(wallet.turnoverAccrued);
    expect(totals.entries).toBe(2);
  });

  it('refuses to let ledger rows be rewritten', async () => {
    const { memberId, walletId } = await createMember();
    const { pspRef } = await createDeposit(memberId, '10.00', 0);
    await sendCallback(pspRef, 'completed', '10.00');

    await expect(
      sequelize.query('UPDATE wallet_txs SET amount = 999 WHERE wallet_id = :walletId', {
        replacements: { walletId },
      }),
    ).rejects.toThrow(/append-only/);

    await expect(
      sequelize.query('DELETE FROM wallet_txs WHERE wallet_id = :walletId', {
        replacements: { walletId },
      }),
    ).rejects.toThrow(/append-only/);
  });
});
