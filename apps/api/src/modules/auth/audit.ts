import { auditLog } from '@logistics/db';

import type { Db } from '../../shared/db.js';

export interface AuditEntry {
  action: string;
  entityType?: string;
  entityId?: string;
  payload?: Record<string, unknown>;
}

export async function writeAudit(
  db: Db,
  ctx: { userId: string; roleName: string } | null,
  entry: AuditEntry,
): Promise<void> {
  await db.insert(auditLog).values({
    userId: ctx?.userId ?? null,
    roleName: ctx?.roleName ?? null,
    action: entry.action,
    entityType: entry.entityType ?? null,
    entityId: entry.entityId ?? null,
    payload: entry.payload ?? null,
  });
}