import request from 'supertest';
import { app, createMember, createDeposit, getWallet, useDatabase } from './helpers';
import { money } from '../src/lib/money';

useDatabase();

describe('POST /deposits', () => {
  it('creates a pending funding transaction and moves no money', async () => {
    const { memberId } = await createMember();

    const res = await request(app)
      .post('/deposits')
      .send({ memberId, amount: '100.50', turnoverMultiplier: 1 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'pending',
      amount: money('100.50'),
      turnoverMultiplier: 1,
    });
    expect(res.body.id).toEqual(expect.any(String));
    expect(res.body.pspRef).toEqual(expect.any(String));

    const wallet = await getWallet(memberId);
    expect(wallet.balance).toBe(money(0));
    expect(wallet.turnoverRequired).toBe(money(0));
  });

  it('defaults turnoverMultiplier to 1', async () => {
    const { memberId } = await createMember();
    const res = await request(app).post('/deposits').send({ memberId, amount: '10' });
    expect(res.status).toBe(201);
    expect(res.body.turnoverMultiplier).toBe(1);
  });

  it('issues a distinct pspRef per deposit', async () => {
    const { memberId } = await createMember();
    const first = await createDeposit(memberId, '10');
    const second = await createDeposit(memberId, '10');
    expect(first.pspRef).not.toBe(second.pspRef);
  });

  it('accepts turnoverMultiplier 0', async () => {
    const { memberId } = await createMember();
    const res = await request(app)
      .post('/deposits')
      .send({ memberId, amount: '10', turnoverMultiplier: 0 });
    expect(res.status).toBe(201);
    expect(res.body.turnoverMultiplier).toBe(0);
  });

  it('rejects amounts that are not positive decimal strings', async () => {
    const { memberId } = await createMember();

    // A JSON number has already lost precision by the time it reaches us; an amount
    // too large for DECIMAL(36,18) is a 400 here, not an overflow at the database.
    const cases: unknown[] = [
      '0',
      '-1',
      '1.2.3',
      'abc',
      '',
      100.5,
      null,
      '1000000000000000000', // 19 integer digits
      '1.0000000000000000001', // 19 decimal places
    ];
    for (const amount of cases) {
      const res = await request(app).post('/deposits').send({ memberId, amount });
      expect([amount, res.status]).toEqual([amount, 400]);
    }
  });

  it('accepts an amount at the full precision of the column', async () => {
    const { memberId } = await createMember();
    const amount = '999999999999999999.999999999999999999';

    const res = await request(app).post('/deposits').send({ memberId, amount });

    expect(res.status).toBe(201);
    expect(res.body.amount).toBe(amount);
  });

  it('rejects a negative turnoverMultiplier and a fractional one', async () => {
    const { memberId } = await createMember();
    for (const turnoverMultiplier of [-1, 1.5]) {
      const res = await request(app)
        .post('/deposits')
        .send({ memberId, amount: '10', turnoverMultiplier });
      expect(res.status).toBe(400);
    }
  });

  it('404s for a member that does not exist', async () => {
    const res = await request(app)
      .post('/deposits')
      .send({ memberId: '00000000-0000-4000-8000-000000000000', amount: '10' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('member_not_found');
  });
});
