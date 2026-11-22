import { drizzle } from "drizzle-orm/sqlite-proxy";

import type { CoreReadDb, CoreReadDbClient } from "../../mastraRead/ports.js";
import * as schema from "../db/schema.js";

/**
 * Wraps a statement client (main's checked adapter, or a test's capture) into
 * the Drizzle db the core's executors take. The core issues Drizzle selects and
 * nothing else; what the client may send is the client's rule
 * (`mastraRead/sql.ts`), not this function's.
 */
export function createCoreReadDb(client: CoreReadDbClient): CoreReadDb {
  return drizzle<typeof schema>(client, { schema });
}
