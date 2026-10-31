import { createHash } from 'node:crypto';
import { withUser } from '../storage/database.ts';
import { ApiError } from '../transcription/security.ts';

export interface HotmartOperationRepository {
  once<T>(ownerId: string, key: string, action: string, input: unknown, work: () => Promise<T>): Promise<T>;
  get<T>(ownerId: string, key: string): Promise<T | null>;
  update<T>(ownerId: string, key: string, value: T, expectedStatus?: string): Promise<void>;
}

/** Durable at-most-once invocation: ambiguous upstream responses never repeat a write. */
export function postgresHotmartOperations(env: NodeJS.ProcessEnv = process.env): HotmartOperationRepository {
  return {
    async once<T>(ownerId: string, key: string, action: string, input: unknown, work: () => Promise<T>): Promise<T> {
      const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const reservation = await withUser(ownerId, async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`hotmart:${ownerId}:${key}`]);
        const existing = await client.query<{ action: string; fingerprint: string; status: string; result: T; expired: boolean }>(
          "SELECT action,fingerprint,status,result,expires_at < now() AS expired FROM grava_storage.hotmart_operations WHERE operation_key=$1", [key],
        );
        const row = existing.rows[0];
        if (row) {
          if (row.action !== action || row.fingerprint !== fingerprint) throw new ApiError(409, 'Esta operação já foi usada com outros dados. Atualize a tela antes de continuar.');
          if (row.expired) throw new ApiError(410, 'Este envio expirou. Confira o conteúdo na Hotmart antes de iniciar outro.');
          if (row.status === 'done') return { cached: true as const, value: row.result };
          throw new ApiError(409, row.status === 'pending'
            ? 'Esta operação ainda está em andamento. Aguarde e tente consultar novamente.'
            : 'A Hotmart não confirmou a operação. Confira seu conteúdo na Hotmart antes de tentar outro envio.');
        }
        await client.query("INSERT INTO grava_storage.hotmart_operations(owner_id,operation_key,action,fingerprint,status) VALUES($1,$2,$3,$4,'pending')", [ownerId, key, action, fingerprint]);
        return { cached: false as const };
      }, env);
      if (reservation.cached) return reservation.value;
      try {
        const value = await work();
        await withUser(ownerId, client => client.query("UPDATE grava_storage.hotmart_operations SET status='done',result=$2 WHERE operation_key=$1 AND status='pending'", [key, JSON.stringify(value)]), env);
        return value;
      } catch (error) {
        await withUser(ownerId, client => client.query("UPDATE grava_storage.hotmart_operations SET status='uncertain' WHERE operation_key=$1 AND status='pending'", [key]), env).catch(() => {});
        throw error;
      }
    },
    get: <T>(ownerId: string, key: string) => withUser(ownerId, async client => {
      const found = await client.query<{ result: T }>("SELECT result FROM grava_storage.hotmart_operations WHERE operation_key=$1 AND status='done' AND expires_at > now()", [key]);
      return found.rows[0]?.result ?? null;
    }, env),
    update: (ownerId, key, value, expectedStatus) => withUser(ownerId, async client => {
      const updated = await client.query("UPDATE grava_storage.hotmart_operations SET result=$2 WHERE operation_key=$1 AND status='done' AND expires_at > now() AND ($3::text IS NULL OR result->>'status'=$3)", [key, JSON.stringify(value), expectedStatus ?? null]);
      // A stale poll must never overwrite a completed/aborted upload. Its caller
      // re-reads the latest state when a conditional transition loses the race.
      if (updated.rowCount !== 1 && expectedStatus === undefined) throw new ApiError(404, 'O envio não foi encontrado.');
    }, env),
  };
}
