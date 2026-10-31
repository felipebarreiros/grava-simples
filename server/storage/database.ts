import { Pool, type PoolClient } from "pg";
import { ApiError } from "../transcription/security.ts";

const pools = new Map<string, Pool>();
export function storagePool(url: string): Pool {
  let pool = pools.get(url);
  if (!pool) {
    // Role-level statement deadlines also work through Supabase's transaction
    // pooler; avoid relying on a session-specific startup parameter there.
    pool = new Pool({ connectionString: url, max: 2, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 8_000, query_timeout: 12_000, application_name: "grava-simples-api" });
    pool.on("error", () => { /* Never print credentials or query parameters. */ });
    pools.set(url, pool);
  }
  return pool;
}

/** The only application data context: verified identity, transaction-local, never a pooled session setting. */
export async function withUser<T>(userId: string, fn: (client: PoolClient) => Promise<T>, env: NodeJS.ProcessEnv = process.env): Promise<T> {
  if (!/^user_[\w-]{1,200}$/.test(userId)) throw new ApiError(401, "Entre novamente na sua conta.");
  if (!env.DATABASE_URL) throw new ApiError(503, "O armazenamento na nuvem ainda não foi configurado.");
  const client = await storagePool(env.DATABASE_URL).connect();
  let destroy = false;
  try {
    await client.query("BEGIN");
    // Fail closed if someone accidentally configures an owner/admin connection.
    const role = await client.query<{ safe: boolean }>(`SELECT current_user = 'grava_app' AND NOT rolsuper AND NOT rolbypassrls AND NOT rolinherit AND NOT rolcreaterole AND NOT rolcreatedb AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='grava_storage' AND c.relowner=r.oid) AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid) AS safe FROM pg_roles r WHERE rolname = current_user`);
    if (role.rows[0]?.safe !== true) throw new ApiError(503, "A conexão segura do banco de dados não está configurada.");
    await client.query("SET LOCAL row_security = on");
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => { destroy = true; });
    throw error;
  } finally {
    client.release(destroy);
  }
}

/** Cron credentials can execute narrow cleanup functions, never read application tables. */
export async function withMaintenance<T>(fn: (client: PoolClient) => Promise<T>, env: NodeJS.ProcessEnv = process.env): Promise<T> {
  if (!env.GRAVA_MAINTENANCE_URL) throw new ApiError(503, "A limpeza da nuvem ainda não foi configurada.");
  const client = await storagePool(env.GRAVA_MAINTENANCE_URL).connect();
  try {
    const role = await client.query<{ safe: boolean }>(`SELECT current_user = 'grava_maintenance' AND NOT rolsuper AND NOT rolbypassrls AND NOT rolinherit AND NOT rolcreaterole AND NOT rolcreatedb AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid) AS safe FROM pg_roles r WHERE rolname = current_user`);
    if (role.rows[0]?.safe !== true) throw new ApiError(503, "A conexão segura de limpeza não está configurada.");
    return await fn(client);
  } finally { client.release(); }
}
