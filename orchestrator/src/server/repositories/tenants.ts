/**
 * Tenant repository — cross-tenant queries used by server-level maintenance and
 * the per-tenant background schedulers.
 *
 * These functions are DELIBERATELY not tenant-scoped: they enumerate tenants so
 * a caller can then establish each tenant's request context (runWithRequestContext
 * + requireTenantId) and do per-tenant work. Do NOT use them inside request-scoped
 * code paths.
 */

import { asc } from "drizzle-orm";
import { db, schema } from "../db/index";

const { tenants } = schema;

export type TenantSummary = {
  id: string;
  name: string;
  slug: string;
};

/** List every tenant, oldest first. Cross-tenant by design (see file header). */
export async function listTenants(): Promise<TenantSummary[]> {
  const rows = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      slug: tenants.slug,
    })
    .from(tenants)
    .orderBy(asc(tenants.createdAt), asc(tenants.id));
  return rows;
}
