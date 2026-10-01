import { Router } from 'express';
import { z } from 'zod';
import { or, sql, eq, and } from 'drizzle-orm';

import { contactIdentities } from '@logistics/db';

import type { Db } from '../../shared/db.js';
import { requireAuth } from '../auth/middleware.js';
import { defineRoute } from '../../openapi/registry.js';

import { SHIPMENT_STATUSES } from './transitions.js';

const TrackedShipment = z.object({
  id: z.string().uuid(),
  status: z.enum(SHIPMENT_STATUSES),
  senderName: z.string(),
  recipientName: z.string(),
  destinationZoneId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

defineRoute({
  method: 'get',
  path: '/tracking/shipments',
  summary: 'List shipments the caller is sender or recipient of',
  responses: {
    200: {
      description: 'Visible shipments',
      content: {
        'application/json': {
          schema: z
            .object({
              shipments: z.array(
                z.object({
                  role: z.enum(['sender', 'recipient']),
                  shipment: TrackedShipment,
                }),
              ),
            })
            .openapi('TrackingResponse'),
        },
      },
    },
  },
});

const SAFE_TRACKING_COLUMNS = {
  id: true,
  status: true,
  senderName: true,
  recipientName: true,
  destinationZoneId: true,
  createdAt: true,
  updatedAt: true,
} as const;

const TRACKED_COLUMNS = {
  ...SAFE_TRACKING_COLUMNS,
  senderUserId: true,
  senderEmail: true,
  senderPhone: true,
} as const;

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
      columns: TRACKED_COLUMNS,
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

    const tagged = rows.map(({ senderUserId, senderEmail, senderPhone, ...shipment }) => ({
      role:
        senderUserId === ctx.userId ||
        senderEmail?.toLowerCase() === email ||
        (senderPhone !== null && phoneSet.has(senderPhone.toLowerCase()))
          ? ('sender' as const)
          : ('recipient' as const),
      shipment,
    }));

    res.json({ shipments: tagged });
  });

  return router;
}
