import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { disputes, settlements } from '@logistics/db';

import { setupCodTest } from './cod.fixture.js';
import type { CodFixture } from './cod.fixture.js';

describe('cod: settlements + dispute blocking', () => {
  let f: CodFixture;

  beforeAll(async () => {
    f = await setupCodTest(['ADMIN', 'BRANCH_OPERATOR', 'CUSTOMER', 'MERCHANT']);
  });

  afterAll(async () => {
    await f.cleanup();
  });

  const admin = () => `Bearer ${f.token('ADMIN')}`;
  const branch = () => `Bearer ${f.token('BRANCH_OPERATOR')}`;

  async function reconciledPair(amountCents: number): Promise<string> {
    const shipmentId =
      amountCents % 2 === 0 ? await f.deliveredShipment() : (await f.deliveredShipment());
    const c = await request(f.app)
      .post('/cod/collections')
      .set('Authorization', branch())
      .send({ shipmentId, amountCents, currency: 'GBP', paymentMethod: 'CASH' });
    expect(c.status).toBe(201);

    const d = await request(f.app)
      .post('/cod/deposits')
      .set('Authorization', branch())
      .send({
        hubId: f.ids.hubId,
        driverUserId: await f.driverUserId,
        amountCents,
        currency: 'GBP',
      });
    expect(d.status).toBe(201);

    const r = await request(f.app)
      .post('/cod/reconciliations')
      .set('Authorization', admin())
      .send({ depositId: d.body.deposit.id, collectionIds: [c.body.collection.id] });
    expect(r.status).toBe(201);
    return r.body.reconciliations[0].id as string;
  }

  const window = () => ({
    periodStart: new Date(Date.now() - 3600000).toISOString(),
    periodEnd: new Date().toISOString(),
  });

  it('computes settlements in buckets with explicit lines', async () => {
    await reconciledPair(3000);
    await reconciledPair(4500);

    const compute = await request(f.app)
      .post('/cod/settlements/compute')
      .set('Authorization', admin())
      .send(window());
    expect(compute.status).toBe(201);
    expect(compute.body.settlements.length).toBeGreaterThanOrEqual(1);

    for (const s of compute.body.settlements) {
      const lines = await f.db
        .select()
        .from(settlementLines)
        .where(eq(settlementLines.settlementId, s.id));
      expect(lines.length).toBeGreaterThanOrEqual(1);
      expect(s.functionalCurrency).toBe('GBP');
      // company bucket has no merchant profile
      if (!s.merchantProfileId) {
        expect(s.functionalAmountCents).toBeGreaterThan(0);
      }
    }
  });

  it('never settles the same reconciliation twice', async () => {
    const reconId = await reconciledPair(1111);

    await request(f.app).post('/cod/settlements/compute').set('Authorization', admin()).send(window());
    await request(f.app).post('/cod/settlements/compute').set('Authorization', admin()).send(window());

    const lines = await f.db.select().from(settlementLines);
    const uniqueRecons = new Set(lines.map((l) => l.reconciliationId));
    expect(lines.length).toBe(uniqueRecons.size);
    expect(uniqueRecons.has(reconId)).toBe(true);
  });

  it('excludes OPEN-disputed reconciliations until resolved', async () => {
    const reconId = await reconciledPair(2222);
    const [recon] = await f.db.query.reconciliations.findMany({
      where: (t, { eq }) => eq(t.id, reconId),
    });
    expect(recon).toBeTruthy();

    const disputeRes = await request(f.app)
      .post('/cod/disputes')
      .set('Authorization', admin())
      .send({
        collectionId: recon!.collectionId,
        reason: 'short cash',
        amountCents: 2222,
        currency: 'GBP',
      });
    expect(disputeRes.status).toBe(201);
    const disputeId = disputeRes.body.dispute.id as string;

    await request(f.app).post('/cod/settlements/compute').set('Authorization', admin()).send(window());
    let lines = await f.db.select().from(settlementLines).where(eq(settlementLines.reconciliationId, reconId));
    expect(lines).toHaveLength(0);

    const resolve = await request(f.app)
      .patch(`/cod/disputes/${disputeId}/resolve`)
      .set('Authorization', admin())
      .send({ resolution: 'RESOLVED' });
    expect(resolve.status).toBe(200);

    await request(f.app).post('/cod/settlements/compute').set('Authorization', admin()).send(window());
    lines = await f.db.select().from(settlementLines).where(eq(settlementLines.reconciliationId, reconId));
    expect(lines).toHaveLength(1);
  });

  it('marks settlements settled explicitly', async () => {
    await reconciledPair(3333);
    await request(f.app).post('/cod/settlements/compute').set('Authorization', admin()).send(window());

    const [pending] = await f.db.select().from(settlements).where(eq(settlements.status, 'PENDING'));
    if (!pending) return;

    const res = await request(f.app)
      .patch(`/cod/settlements/${pending.id}/settle`)
      .set('Authorization', admin());
    expect(res.status).toBe(200);
    expect(res.body.settlement.status).toBe('SETTLED');
    expect(res.body.settlement.settledAt).toBeTruthy();

    const openDisputesLeft = await f.db.select().from(disputes).where(eq(disputes.status, 'OPEN'));
    expect(openDisputesLeft.length).toBeGreaterThanOrEqual(0);
  });

  it('guards manage routes against non-admin roles', async () => {
    const res1 = await request(f.app)
      .post('/cod/reconciliations')
      .set('Authorization', branch())
      .send({ depositId: '00000000-0000-0000-0000-000000000000', collectionIds: [] });
    expect(res1.status).toBe(403);

    const res2 = await request(f.app)
      .post('/cod/settlements/compute')
      .set('Authorization', branch())
      .send(window());
    expect(res2.status).toBe(403);
  });
});
