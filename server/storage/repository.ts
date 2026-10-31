import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withUser } from "./database.ts";
import { ApiError } from "../transcription/security.ts";
import { MAX_STORAGE_BYTES, publicRecording, type StoredRecording, type RecordingMetadata, type StorageRepository } from "./types.ts";

type Row = { id: string; owner_id: string; local_id: string; metadata: RecordingMetadata; status: StoredRecording["status"]; expires_at: Date; created_at: Date; cursor_time: string };
async function stored(client: PoolClient, row: Row): Promise<StoredRecording> {
  const assets = await client.query<{ orientation: "landscape" | "portrait"; pathname: string; expected_bytes: string; content_type: string }>("SELECT orientation, pathname, expected_bytes, content_type FROM grava_storage.assets WHERE recording_id = $1", [row.id]);
  return { id: row.id, ownerId: row.owner_id, localId: row.local_id, metadata: row.metadata, status: row.status, expiresAt: new Date(row.expires_at).getTime(), assets: assets.rows.map(a => ({ orientation: a.orientation, pathname: a.pathname, expectedBytes: Number(a.expected_bytes), contentType: a.content_type })) };
}
export function postgresRecordings(env: NodeJS.ProcessEnv = process.env): StorageRepository {
  return {
    list: (userId, cursor) => withUser(userId, async client => {
      let boundary: [string,string] | null = null;
      if (cursor) {
        try {
          const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
          if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string" || !/^\d{4}-\d\d-\d\dT[0-9:.]+Z$/.test(value[0]) || !Number.isFinite(Date.parse(value[0])) || typeof value[1] !== "string" || !/^[a-f0-9-]{36}$/.test(value[1])) throw new Error();
          boundary = [value[0], value[1]];
        } catch { throw new ApiError(400, "A página de gravações é inválida."); }
      }
      const rows = await client.query<Row>("SELECT id,owner_id,local_id,metadata,status,expires_at,created_at,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS cursor_time FROM grava_storage.recordings WHERE status <> 'deleting'" + (boundary ? " AND (created_at,id) < ($1::timestamptz,$2::uuid)" : "") + " ORDER BY created_at DESC,id DESC LIMIT 26", boundary ?? []);
      const usage = await client.query<{ used: string }>("SELECT coalesce(sum(reserved_bytes),0)::text AS used FROM grava_storage.recordings");
      const selected = rows.rows.slice(0,25), last = selected.at(-1);
      const nextCursor = rows.rows.length > 25 && last ? Buffer.from(JSON.stringify([last.cursor_time,last.id])).toString("base64url") : null;
      return { recordings: selected.map(row => ({ ...row.metadata, id: row.id, localId: row.local_id, status: row.status })), usedBytes: Number(usage.rows[0].used), nextCursor };
    }, env),
    reserve: (userId, metadata) => withUser(userId, async client => {
      // A single account's reservations and deletions serialize across Functions.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [userId]);
      const prior = await client.query<Row>("SELECT id,owner_id,local_id,metadata,status,expires_at,created_at FROM grava_storage.recordings WHERE local_id = $1 FOR UPDATE", [metadata.id]);
      if (prior.rows[0]) {
        if (prior.rows[0].status === "deleting") throw new ApiError(409, "A exclusão desta gravação ainda está em andamento.");
        if (prior.rows[0].status === "pending" && new Date(prior.rows[0].expires_at).getTime() <= Date.now()) throw new ApiError(409, "Este envio expirou. Remova a cópia incompleta da nuvem e tente novamente.");
        // A local identifier cannot repurpose an earlier reservation or overwrite a backup.
        for (const key of ["landscape", "portrait"] as const) if (prior.rows[0].metadata[key].size !== metadata[key].size || prior.rows[0].metadata[key].mimeType !== metadata[key].mimeType) throw new ApiError(409, "Esta gravação já tem uma cópia diferente na nuvem.");
        return stored(client, prior.rows[0]);
      }
      const usage = await client.query<{ used: string; count: string }>("SELECT coalesce(sum(reserved_bytes),0)::text AS used, count(*)::text AS count FROM grava_storage.recordings");
      const bytes = metadata.landscape.size + metadata.portrait.size;
      if (Number(usage.rows[0].used) + bytes > MAX_STORAGE_BYTES || Number(usage.rows[0].count) >= 1000) throw new ApiError(413, "O limite de armazenamento na nuvem foi atingido (10 GB ou 1.000 gravações).");
      const id = randomUUID();
      const inserted = await client.query<Row>("INSERT INTO grava_storage.recordings(id,owner_id,local_id,metadata,reserved_bytes) VALUES($1,$2,$3,$4,$5) RETURNING id,owner_id,local_id,metadata,status,expires_at,created_at", [id,userId,metadata.id,metadata,bytes]);
      for (const orientation of ["landscape", "portrait"] as const) {
        const media = metadata[orientation];
        const extension = media.mimeType === "video/mp4" ? "mp4" : "webm";
        await client.query("INSERT INTO grava_storage.assets(recording_id,owner_id,orientation,pathname,expected_bytes,content_type) VALUES($1,$2,$3,$4,$5,$6)", [id,userId,orientation,`recordings/${userId}/${id}/${orientation}.${extension}`,media.size,media.mimeType]);
      }
      return stored(client, inserted.rows[0]);
    }, env),
    get: (userId, id) => withUser(userId, async client => {
      const result = await client.query<Row>("SELECT id,owner_id,local_id,metadata,status,expires_at,created_at FROM grava_storage.recordings WHERE id = $1", [id]);
      return result.rows[0] ? stored(client, result.rows[0]) : null;
    }, env),
    complete: (userId, id) => withUser(userId, async client => {
      const result = await client.query<Row>("UPDATE grava_storage.recordings SET status='ready',updated_at=now() WHERE id=$1 AND (status='ready' OR (status='pending' AND expires_at > now())) RETURNING id,owner_id,local_id,metadata,status,expires_at,created_at", [id]);
      if (!result.rows[0]) throw new ApiError(409, "Este envio expirou ou foi removido. Tente novamente.");
      return stored(client, result.rows[0]);
    }, env),
    markDeleting: (userId, id) => withUser(userId, async client => {
      const result = await client.query<Row>("UPDATE grava_storage.recordings SET status='deleting',updated_at=now(),expires_at=CASE WHEN status='deleting' THEN expires_at ELSE greatest(expires_at,now()+interval '20 minutes') END WHERE id=$1 RETURNING id,owner_id,local_id,metadata,status,expires_at,created_at", [id]);
      return result.rows[0] ? stored(client, result.rows[0]) : null;
    }, env),
    getTranscript: (userId, id) => withUser(userId, async client => {
      const result = await client.query<{ transcript: unknown; transcript_version: number }>("SELECT transcript, transcript_version FROM grava_storage.recordings WHERE id=$1 AND status='ready'", [id]);
      if (!result.rows[0]) throw new ApiError(404, "Gravação não encontrada.");
      return { transcript: result.rows[0].transcript, version: result.rows[0].transcript_version };
    }, env),
    saveTranscript: (userId, id, transcript, expectedVersion) => withUser(userId, async client => {
      const result = await client.query<{ transcript_version: number }>("UPDATE grava_storage.recordings SET transcript=$2,transcript_version=transcript_version+1,updated_at=now() WHERE id=$1 AND status='ready' AND transcript_version=$3 RETURNING transcript_version", [id,transcript,expectedVersion]);
      if (!result.rows[0]) throw new ApiError(409, "A transcrição mudou em outro dispositivo. Abra a versão mais recente antes de salvar.");
      return { version: result.rows[0].transcript_version };
    }, env),
    remove: (userId, id) => withUser(userId, async client => {
      await client.query("DELETE FROM grava_storage.recordings WHERE id=$1 AND status='deleting' AND expires_at <= now()", [id]);
    }, env),
  };
}
