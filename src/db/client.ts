import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./schema";

export type Db = DrizzleD1Database<typeof schema>;

/** D1 binding + Sessions API bookmark for read-your-writes across the edge (TRD §3.2). */
export function createDb(d1: D1Database): Db {
  return drizzle(d1, { schema });
}

export { schema };
