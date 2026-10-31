export const MAX_RECORDING_BYTES = 512 * 1024 * 1024;
export const MAX_STORAGE_BYTES = 10 * 1024 * 1024 * 1024;
export const UPLOAD_LIFETIME_MS = 60 * 60 * 1000;
export type Orientation = "landscape" | "portrait";
export interface SavedFile { fileName: string; mimeType: string; size: number }
export interface RecordingMetadata {
  id: string; projectId: string; projectName: string; name: string;
  createdAt: number; startedAt: number; stoppedAt: number; durationMs: number;
  thumbnail?: string; thumbnailAtSeconds?: number; warnings: string[];
  landscape: SavedFile; portrait: SavedFile;
}
export interface CloudRecording extends Omit<RecordingMetadata, "id"> { id: string; localId: string; status: "pending" | "ready" | "deleting" }
export interface StoredRecording { id: string; ownerId: string; localId: string; metadata: RecordingMetadata; status: CloudRecording["status"]; expiresAt: number; assets: Array<{ orientation: Orientation; pathname: string; expectedBytes: number; contentType: string }> }
export interface StorageRepository {
  list(userId: string, cursor?: string | null): Promise<{ recordings: CloudRecording[]; usedBytes: number; nextCursor: string | null }>;
  reserve(userId: string, metadata: RecordingMetadata): Promise<StoredRecording>;
  get(userId: string, id: string): Promise<StoredRecording | null>;
  complete(userId: string, id: string): Promise<StoredRecording>;
  markDeleting(userId: string, id: string): Promise<StoredRecording | null>;
  remove(userId: string, id: string): Promise<void>;
  getTranscript(userId: string, id: string): Promise<{ transcript: unknown; version: number }>;
  saveTranscript(userId: string, id: string, transcript: unknown, expectedVersion: number): Promise<{ version: number }>;
}
export interface StorageDependencies {
  configured: boolean;
  authenticate(request: Request): Promise<{ userId: string }>;
  repository: StorageRepository;
  quota(userId: string, action: "request" | "reserve" | "upload"): Promise<void>;
  blob: {
    head(pathname: string): Promise<{ pathname: string; url: string; size: number; contentType: string }>;
    signedGet(pathname: string): Promise<{ url: string; expiresAt: number }>;
    delete(pathnames: string[]): Promise<void>;
  };
  now(): number;
}
export const publicRecording = (recording: StoredRecording): CloudRecording => ({ ...recording.metadata, id: recording.id, localId: recording.localId, status: recording.status });
