import { auditLog } from '@logistics/db';

import type { Db } from '../../shared/db.js';
import { logger } from '../../shared/logger.js';

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
  try {
    await db.insert(auditLog).values({
      userId: ctx?.userId ?? null,
      roleName: ctx?.roleName ?? null,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      payload: entry.payload ?? null,
    });
  } catch (err) {
    logger.error({ err, action: entry.action, entityType: entry.entityType ?? null, entityId: entry.entityId ?? null }, 'auth.audit-write-failed');
    throw err;
  }
}