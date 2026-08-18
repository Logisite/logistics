import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { users } from './identity.js';

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    roleName: text('role_name'),
    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    payload: jsonb('payload'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_user_id_idx').on(t.userId),
    index('audit_log_entity_type_idx').on(t.entityType),
    index('audit_log_occurred_at_idx').on(t.occurredAt),
  ],
);