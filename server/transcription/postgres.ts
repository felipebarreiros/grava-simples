import { randomUUID } from 'node:crypto';
import { withMaintenance, withUser } from '../storage/database.ts';
import { ApiError } from './security.ts';
import type { JobRepository, TranscriptionJob } from './types.ts';

async function dueJobs(now: number, limit: number, env: NodeJS.ProcessEnv) {
  return withMaintenance(async client => {
    const rows = await client.query('SELECT * FROM grava_storage.due_transcriptions($1, $2)', [now, limit]);
    return rows.rows.map(row => ({ userId: String(row.owner_id), recordingId: String(row.recording_id) }));
  }, env);
}

export function postgresRepository(env: NodeJS.ProcessEnv = process.env): JobRepository {
  return {
    get: (userId, recordingId) => withUser(userId, async client => {
      const result = await client.query('SELECT job FROM grava_storage.transcription_jobs WHERE owner_id=$1 AND recording_id=$2', [userId, recordingId]);
      return (result.rows[0]?.job ?? null) as TranscriptionJob | null;
    }, env),
    save: job => withUser(job.userId, async client => {
      await client.query(`INSERT INTO grava_storage.transcription_jobs(owner_id,recording_id,job,expires_at)
        VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(owner_id,recording_id)
        DO UPDATE SET job=EXCLUDED.job,expires_at=EXCLUDED.expires_at`, [job.userId, job.recordingId, JSON.stringify(job), job.expiresAt]);
    }, env),
    acquire: (userId, recordingId) => withUser(userId, async client => {
      const token = randomUUID();
      const result = await client.query(`INSERT INTO grava_storage.transcription_jobs(owner_id,recording_id,expires_at,lock_token,lock_until)
        VALUES($1,$2,(extract(epoch FROM clock_timestamp())*1000)::bigint + 86400000,$3,clock_timestamp()+interval '45 seconds')
        ON CONFLICT(owner_id,recording_id) DO UPDATE SET lock_token=EXCLUDED.lock_token,lock_until=EXCLUDED.lock_until
        WHERE transcription_jobs.lock_until IS NULL OR transcription_jobs.lock_until <= clock_timestamp()
        RETURNING lock_token`, [userId, recordingId, token]);
      return result.rowCount ? token : null;
    }, env),
    release: (userId, recordingId, token) => withUser(userId, async client => {
      await client.query('UPDATE grava_storage.transcription_jobs SET lock_token=NULL,lock_until=NULL WHERE owner_id=$1 AND recording_id=$2 AND lock_token=$3', [userId, recordingId, token]);
    }, env),
    due: (now, limit) => dueJobs(now, limit, env),
    remove: (userId, recordingId) => withUser(userId, async client => {
      await client.query('DELETE FROM grava_storage.transcription_jobs WHERE owner_id=$1 AND recording_id=$2', [userId, recordingId]);
    }, env),
  };
}

/** One atomic UPSERT serializes concurrent requests across Vercel instances. */
export async function postgresQuota(userId: string, action: 'poll' | 'submit' | 'upload' | 'delete', env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const seconds = action === 'poll' || action === 'delete' ? 60 : 86400;
  const limit = seconds === 60 ? 60 : 6;
  return consumeQuota(userId, action, limit, seconds, env);
}

export async function consumeQuota(userId: string, action: 'poll' | 'submit' | 'upload' | 'delete' | 'storage_request' | 'storage_reserve' | 'storage_upload', limit: number, seconds: number, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000 || !Number.isSafeInteger(seconds) || seconds < 1 || seconds > 86400)
    throw new ApiError(503, 'Os limites do serviço não estão configurados.');
  const result = await withUser(userId, client => client.query(`
    INSERT INTO grava_storage.rate_buckets(owner_id,action,count,reset_at)
    VALUES($1,$2,1,clock_timestamp()+make_interval(secs => $3))
    ON CONFLICT(owner_id,action) DO UPDATE SET
      count=CASE WHEN rate_buckets.reset_at<=clock_timestamp() THEN 1 ELSE rate_buckets.count+1 END,
      reset_at=CASE WHEN rate_buckets.reset_at<=clock_timestamp() THEN clock_timestamp()+make_interval(secs => $3) ELSE rate_buckets.reset_at END
    RETURNING count,greatest(1,ceil(extract(epoch FROM(reset_at-clock_timestamp())))) AS retry_after
  `, [userId, action, seconds]), env);
  if (Number(result.rows[0]?.count) > limit)
    throw new ApiError(429, 'Limite de solicitações atingido. Tente novamente mais tarde.', Number(result.rows[0].retry_after));
  if (!Number.isSafeInteger(Number(result.rows[0]?.count)) || Number(result.rows[0]?.count) < 1)
    throw new ApiError(503, 'Não foi possível verificar o limite de transcrições.');
}
