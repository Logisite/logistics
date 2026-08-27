import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import type * as schema from '@logistics/db';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;