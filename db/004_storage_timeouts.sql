-- Defaults apply when these restricted roles connect through Supabase's pooler.
ALTER ROLE grava_app SET statement_timeout = '10s';
ALTER ROLE grava_app SET lock_timeout = '8s';
ALTER ROLE grava_maintenance SET statement_timeout = '10s';
ALTER ROLE grava_maintenance SET lock_timeout = '8s';
