import { Router } from 'express';
import { or, sql, eq, and } from 'drizzle-orm';

import { contactIdentities } from '@logistics/db';

import type { Db } from '../../shared/db.js';
import { requireAuth } from '../../auth/middleware.js';
import { defineRoute } from '../../openapi/registry.js';

defineRoute({ method: 'get', path: '/tracking/shipments', responses: { 200: { description: 'ok' }, 401: { description: 'unauthorized' } } });

export function trackingRouter(db: Db): Router {
  const router = Router();

  router.get('/shipments', requireAuth(db), async (req, res) => {
    const ctx = res.locals.auth as { userId: string; email: string };
    const email = ctx.email.toLowerCase();

    const phoneRows = await db
      .select({ identifier: contactIdentities.identifier })
      .from(contactIdentities)
      .where(
        and(
          eq(contactIdentities.userId, ctx.userId),
          eq(contactIdentities.channel, 'PHONE'),
        ),
      );

    const phones = phoneRows.map((r) => r.identifier);
    const phoneSet = new Set(phones.map((p) => p.toLowerCase()));

    const rows = await db.query.shipments.findMany({
      where: (t, { eq: eq }) =>
        or(
          eq(t.senderUserId, ctx.userId),
          sql`lower(${t.senderEmail}) = ${email}`,
          sql`lower(${t.recipientEmail}) = ${email}`,
          phones.length > 0 ? sql`${t.senderPhone} = ANY(${phones})` : sql`false`,
          phones.length > 0 ? sql`${t.recipientPhone} = ANY(${phones})` : sql`false`,
        ),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });

    const tagged = rows.map((shipment) => ({
      role:
        shipment.senderUserId === ctx.userId ||
        shipment.senderEmail?.toLowerCase() === email ||
        (shipment.senderPhone && phoneSet.has(shipment.senderPhone.toLowerCase()))
          ? ('sender' as const)
          : ('recipient' as const),
      shipment,
    }));

    res.json({ shipments: tagged });
  });

  return router;
}
