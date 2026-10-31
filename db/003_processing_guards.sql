-- CHECK treats NULL as satisfied; require both encoded ownership fields.
ALTER TABLE grava_storage.transcription_jobs
  DROP CONSTRAINT IF EXISTS transcription_jobs_check;
ALTER TABLE grava_storage.transcription_jobs
  ADD CONSTRAINT transcription_job_owner_required CHECK (
    job IS NULL OR (
      job->>'userId' IS NOT DISTINCT FROM owner_id AND
      job->>'recordingId' IS NOT DISTINCT FROM recording_id
    )
  );
ALTER TABLE grava_storage.rate_buckets DROP CONSTRAINT IF EXISTS rate_buckets_action_check;
ALTER TABLE grava_storage.rate_buckets ADD CONSTRAINT rate_bucket_action_allowed
  CHECK(action IN ('poll','submit','upload','delete','storage_request','storage_reserve','storage_upload'));
