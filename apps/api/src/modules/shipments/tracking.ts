import { Router } from 'express';
import { or, sql } from 'drizzle-orm';

import type { Db } from '../../db.js';
import { requireAuth } from '../../auth/middleware.js';
import { defineRoute } from '../../openapi/registry.js';

defineRoute({ method: 'get', path: '/tracking/shipments', responses: { 200: { description: 'ok' }, 401: { description: 'unauthorized' } } });

export function trackingRouter(db: Db): Router {
  const router = Router();

  router.get('/shipments', requireAuth(db), async (req, res) => {
    const ctx = res.locals.auth as { userId: string; email: string };
    const email = ctx.email.toLowerCase();

    const rows = await db.query.shipments.findMany({
      where: (t, { eq: eq }) =>
        or(
          eq(t.senderUserId, ctx.userId),
          sql`lower(${t.senderEmail}) = ${email}`,
          sql`lower(${t.recipientEmail}) = ${email}`,
        ),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });

    const tagged = rows.map((shipment) => ({
      role:
        shipment.senderUserId === ctx.userId ||
        shipment.senderEmail?.toLowerCase() === email
          ? ('sender' as const)
          : ('recipient' as const),
      shipment,
    }));

    res.json({ shipments: tagged });
  });

  return router;
}
