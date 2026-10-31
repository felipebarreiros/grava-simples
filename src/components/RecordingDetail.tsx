import { useEffect, useMemo, useRef, useState, type ReactNode, type MouseEvent } from "react";
import { materializeRecordingFile, refreshCloudMediaUrl, getStoredCloudTranscript, saveStoredCloudTranscript } from "../recordings/cloudStorage";
import { useAuth } from "@clerk/react";
import { reportApplicationError, trackCreatorEvent } from '../analytics/client';
import { recordingFileProperties } from '../analytics/recordingMetrics';
import {
  ArrowLeft,
  ArrowDownToLine,
  BookmarkPlus,
  ChevronDown,
  Download,
  FileText,
  LoaderCircle,
  Maximize,
  Monitor,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Search,
  SkipBack,
  SkipForward,
  Smartphone,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import type {
  Orientation,
  RecordingFile,
  RecordingResult,
} from "../media/types";
import type { ProjectTake } from "../projects/store";
import {
  deleteTranscript,
  exportTranscript,
  loadTranscript,
  saveTranscript,
  updateTranscriptCue,
  type Transcript,
} from "../recordings/transcript";
import { loadReview, saveReview } from "../recordings/review";
import { Button } from "./ui/button";
import { Input, Textarea } from "./ui/input";
import { Slider } from "./ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { AlertDialog } from "./ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Select } from "./Select";
import { IconButton } from "./StudioUi";
import {
  automaticTranscriptionAttempt,
  claimAutomaticTranscription,
  markAutomaticTranscription,
  clearCloudReplacement,
  deleteCloudTranscription,
  getCloudTranscription,
  rememberCloudTranscription,
  shouldReplaceCloudTranscript,
  startCloudTranscription,
  TranscriptionRequestError,
  type CloudTranscription,
} from "../recordings/cloudTranscription";
import "./RecordingDetail.css";

export interface RecordingDownloadState {
  busy?: boolean;
  label?: string;
  error?: string;
  file?: RecordingFile;
}
interface Props {
  take: ProjectTake;
  projectName: string;
  result: RecordingResult;
  downloads: Record<string, RecordingDownloadState>;
  storageActions?: ReactNode;
  onBack: () => void;
  onRename: () => void;
  onDownload: (file: RecordingFile) => void;
}
const clock = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  return `${hours ? `${hours}:` : ""}${String(Math.floor(whole / 60) % 60).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
};
const normalize = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
const failureMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Não foi possível concluir. Tente novamente.";

function MatchedText({ text, query }: { text: string; query: string }) {
  const index = query ? normalize(text).indexOf(normalize(query)) : -1;
  return index < 0 ? (
    <>{text}</>
  ) : (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + query.length)}</mark>
      {text.slice(index + query.length)}
    </>
  );
}

export function RecordingDetail({
  take,
  projectName,
  result,
  downloads,
  storageActions,
  onBack,
  onRename,
  onDownload,
}: Props) {
  const { getToken, userId } = useAuth();
  const [orientation, setOrientation] = useState<Orientation>("landscape");
  const [position, setPosition] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState("1");
  const [mediaError, setMediaError] = useState("");
  const [remoteUrls, setRemoteUrls] = useState<Partial<Record<Orientation, string>>>({});
  const mediaRenewing = useRef(false);
  const mediaRenewedAt = useRef(0);
  const [storedTranscriptVersion, setStoredTranscriptVersion] = useState<number | null>(null);
  const [storedTranscriptLoaded, setStoredTranscriptLoaded] = useState(!take.cloud);
  const [storedTranscriptError, setStoredTranscriptError] = useState("");
  const [storedTranscriptReload, setStoredTranscriptReload] = useState(0);
  const [storedTranscriptStatus, setStoredTranscriptStatus] = useState("");
  const [savingStoredTranscript, setSavingStoredTranscript] = useState(false);
  const [error, setError] = useState("");
  const [dismissedDownloadError, setDismissedDownloadError] = useState("");
  const [transcript, setTranscript] = useState(() => loadTranscript(take.id));
  const [review, setReview] = useState(() => loadReview(take.id));
  const [removeTranscript, setRemoveTranscript] = useState(false);
  const [query, setQuery] = useState("");
  const [following, setFollowing] = useState(true);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(
    null,
  );
  const [note, setNote] = useState("");
  const [leftTab, setLeftTab] = useState("transcript");
  const [cloud, setCloud] = useState<CloudTranscription | null>(null);
  const [cloudError, setCloudError] = useState("");
  const [cloudUploadProgress, setCloudUploadProgress] = useState<number | null>(
    null,
  );
  const [removingTranscript, setRemovingTranscript] = useState(false);
  const [cancellingCloud, setCancellingCloud] = useState(false);
  const [cloudReload, setCloudReload] = useState(0);
  const [automaticAttempt, setAutomaticAttempt] = useState(() => userId ? automaticTranscriptionAttempt(userId, take.id) : null);
  const [automaticPending, setAutomaticPending] = useState(false);
  const remoteSaveAttempt = useRef<string | null>(null);
  const cloudRequest = useRef<AbortController | null>(null);
  const cloudPoll = useRef<AbortController | null>(null);
  const cloudEpoch = useRef(0);
  const cloudOperation = useRef<Promise<CloudTranscription> | null>(null);
  const cancelRequested = useRef(false);
  const tokenGetter = useRef(getToken);
  tokenGetter.current = getToken;
  const currentTranscript = useRef(transcript);
  currentTranscript.current = transcript;
  const video = useRef<HTMLVideoElement>(null);
  const player = useRef<HTMLDivElement>(null);
  const cueList = useRef<HTMLDivElement>(null);
  const activeCue = useRef<HTMLElement | null>(null);
  const positionRef = useRef(0);
  const resumeAfterSwitch = useRef(false);
  const requestedOrientation = useRef<Orientation>("landscape");
  const mounted = useRef(true);
  const duration = mediaDuration || take.durationMs / 1000;
  const file = remoteUrls[orientation] ? { ...result[orientation], url: remoteUrls[orientation]! } : result[orientation];
  const download = downloads[`${take.id}-${orientation}`];
  const visibleDownloadError =
    download?.error !== dismissedDownloadError ? download?.error : "";
  const anyDownloadBusy = Object.values(downloads).some((item) => item.busy);
  const cloudBusy =
    automaticPending ||
    cancellingCloud ||
    cloudUploadProgress !== null ||
    cloud?.status === "queued" ||
    cloud?.status === "processing";
  const transcriptionFile =
    result.landscape.size <= result.portrait.size
      ? result.landscape
      : result.portrait;
  const transcriptionTooLong =
    Math.max(take.durationMs / 1000, mediaDuration) >
    (cloud?.maxAudioSeconds ?? 7200);
  const wordsByCue = useMemo(() => {
    const grouped = new Map<string, NonNullable<Transcript["words"]>>();
    if (!transcript?.words?.length) return grouped;
    let index = 0;
    for (const cue of transcript.cues) {
      const words: NonNullable<Transcript["words"]> = [];
      while (
        index < transcript.words.length &&
        transcript.words[index].start < cue.start
      )
        index++;
      while (
        index < transcript.words.length &&
        transcript.words[index].start < cue.end
      )
        words.push(transcript.words[index++]);
      if (!cue.originalText && words.length) grouped.set(cue.id, words);
    }
    return grouped;
  }, [transcript]);

  const currentCueId = transcript?.cues.find(
    (cue) => position >= cue.start && position < cue.end,
  )?.id;
  const filteredCues = useMemo(
    () =>
      transcript?.cues.filter((cue) =>
        normalize(cue.text).includes(normalize(query.trim())),
      ) ?? [],
    [transcript, query],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cloudRequest.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!take.cloud) return;
    let cancelled = false;
    void getStoredCloudTranscript(take.cloud.id, () => tokenGetter.current()).then(remote => {
      if (cancelled || !mounted.current) return;
      setStoredTranscriptVersion(remote.version);
      setStoredTranscriptError("");
      if (remote.transcript && !currentTranscript.current) {
        currentTranscript.current = remote.transcript; setTranscript(remote.transcript);
        try {
          const saved = saveTranscript(take.id, remote.transcript);
          currentTranscript.current = saved; setTranscript(saved);
          setStoredTranscriptStatus('Transcrição recuperada da nuvem.');
        } catch {
          setStoredTranscriptStatus('Transcrição disponível na nuvem. Não foi possível salvar uma cópia neste dispositivo.');
        }
      } else if (!remote.transcript) {
        setStoredTranscriptStatus(currentTranscript.current ? 'Transcrição salva apenas neste dispositivo.' : 'Sem transcrição na nuvem.');
      } else if (remote.transcript && currentTranscript.current) {
        const shape = (value: Transcript) => JSON.stringify({ ...value, updatedAt: 0 });
        setStoredTranscriptStatus(shape(remote.transcript) === shape(currentTranscript.current) ? 'Transcrição salva na nuvem.' : 'Sua versão local foi preservada. Envie-a para atualizar a cópia na nuvem.');
      }
      setStoredTranscriptLoaded(true);
    }).catch(failure => { if (!cancelled && mounted.current) { setStoredTranscriptLoaded(false); setStoredTranscriptError(failureMessage(failure)); setStoredTranscriptStatus(failureMessage(failure)); } });
    return () => { cancelled = true; };
  }, [take.id, take.cloud?.id, storedTranscriptReload]);
  async function persistStoredTranscript(value = currentTranscript.current) {
    if (!take.cloud) return;
    if (savingStoredTranscript) throw new Error('Aguarde a transcrição terminar de salvar.');
    setSavingStoredTranscript(true);
    try {
      const current = storedTranscriptVersion === null ? await getStoredCloudTranscript(take.cloud.id, () => tokenGetter.current()) : { version: storedTranscriptVersion };
      const version = await saveStoredCloudTranscript(take.cloud.id, value, current.version, () => tokenGetter.current());
      if (mounted.current) { setStoredTranscriptVersion(version); setStoredTranscriptStatus('Transcrição salva na nuvem.'); }
    } catch (failure) {
      if (mounted.current) setStoredTranscriptStatus(`${failureMessage(failure)} Sua versão local foi preservada. Reabra a gravação para conferir a versão na nuvem.`);
      throw failure;
    } finally { if (mounted.current) setSavingStoredTranscript(false); }
  }
  async function renewMedia() {
    if (!take.cloud || mediaRenewing.current || Date.now() - mediaRenewedAt.current < 30_000) {
      setMediaError('Não foi possível carregar a prévia. Reabra a gravação e tente novamente.'); return;
    }
    mediaRenewing.current = true; mediaRenewedAt.current = Date.now();
    const requested = orientation;
    positionRef.current = video.current?.currentTime || positionRef.current;
    resumeAfterSwitch.current = playing;
    try {
      const url = await refreshCloudMediaUrl(take.cloud.id, requested, () => tokenGetter.current());
      if (mounted.current) { setRemoteUrls(previous => ({ ...previous, [requested]: url })); setMediaError(''); }
    } catch (failure) { if (mounted.current) setMediaError(failureMessage(failure)); }
    finally { mediaRenewing.current = false; }
  }
  async function downloadOriginal(event: MouseEvent<HTMLAnchorElement>, chosen: Orientation) {
    const original = result[chosen];
    trackCreatorEvent('download_requested', { ...recordingFileProperties(original), download_kind: 'original' });
    if (original.blob.size || !take.cloud) return;
    event.preventDefault();
    try {
      const materialized = await materializeRecordingFile(original, undefined, { id: take.cloud.id, getToken: () => tokenGetter.current() });
      if (!mounted.current) return;
      const url = URL.createObjectURL(materialized.blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = original.fileName; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (failure) { if (mounted.current) setError(failureMessage(failure)); }
  }
  useEffect(() => {
    const controller = new AbortController();
    cloudPoll.current = controller;
    const epoch = cloudEpoch.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refreshCloud = async () => {
      if (controller.signal.aborted || epoch !== cloudEpoch.current) return;
      try {
        const next = await getCloudTranscription(
          take.id,
          () => tokenGetter.current(),
          controller.signal,
        );
        if (controller.signal.aborted || epoch !== cloudEpoch.current) return;
        setCloud(next);
        setCloudError("");
        if (userId && next.configured && next.status !== "idle")
          rememberCloudTranscription(userId, take.id);
        if (
          next.status === "completed" &&
          next.transcript &&
          storedTranscriptLoaded &&
          !cancelRequested.current &&
          !(userId && ["cancelled", "removed"].includes(automaticTranscriptionAttempt(userId, take.id) ?? "")) &&
          (!currentTranscript.current ||
            (userId &&
              shouldReplaceCloudTranscript(userId, take.id, next.jobId)))
        ) {
          let saved = next.transcript;
          currentTranscript.current = saved; setTranscript(saved);
          try { saved = saveTranscript(take.id, saved); currentTranscript.current = saved; setTranscript(saved); }
          catch { setError("A transcrição está pronta, mas não foi possível salvá-la neste dispositivo."); }
          if (userId) clearCloudReplacement(userId, take.id);
          if (take.cloud && remoteSaveAttempt.current !== next.jobId) {
            remoteSaveAttempt.current = next.jobId ?? take.id;
            void persistStoredTranscript(saved).catch(() => undefined);
          }
        }
        if (next.status === "queued" || next.status === "processing")
          timer = setTimeout(refreshCloud, 5000);
      } catch (error) {
        if (controller.signal.aborted || epoch !== cloudEpoch.current) return;
        setCloudError(failureMessage(error));
        if (
          !(error instanceof TranscriptionRequestError && error.status === 401)
        ) {
          const retry =
            error instanceof TranscriptionRequestError
              ? Math.max(error.retryAfter * 1000, 15000)
              : 15000;
          timer = setTimeout(refreshCloud, Math.min(retry, 2147483647));
        }
      }
    };
    void refreshCloud();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [take.id, userId, cloudReload, storedTranscriptLoaded]);

  async function generateTranscript() {
    if (!userId || cloudRequest.current || cloudOperation.current || cancellingCloud || currentTranscript.current || !cloud?.configured || transcriptionTooLong || !storedTranscriptLoaded || storedTranscriptError) return;
    markAutomaticTranscription(userId, take.id, "started");
    setAutomaticAttempt("started");
    setCloudError("");
    setCloudUploadProgress(0);
    cloudEpoch.current++;
    cloudPoll.current?.abort();
    cancelRequested.current = false;
    const controller = new AbortController();
    cloudRequest.current = controller;
    const operation = (async () => {
      if (cloud && ["completed", "error", "uploading"].includes(cloud.status))
        await deleteCloudTranscription(take.id, () => tokenGetter.current(), controller.signal, userId);
      controller.signal.throwIfAborted();
      return startCloudTranscription({
        recordingId: take.id,
        userId,
        file: await materializeRecordingFile(transcriptionFile, controller.signal, take.cloud ? { id: take.cloud.id, getToken: () => tokenGetter.current() } : undefined),
        getToken: () => tokenGetter.current(),
        signal: controller.signal,
        onProgress: percentage => { if (mounted.current && !cancelRequested.current) setCloudUploadProgress(percentage); },
      });
    })();
    cloudOperation.current = operation;
    try {
      const next = await operation;
      trackCreatorEvent('transcription_requested');
      if (!mounted.current || cancelRequested.current) return;
      setCloud(next);
      setCloudReload(value => value + 1);
    } catch (failure) {
      if (!controller.signal.aborted) reportApplicationError(failure, 'transcription');
      if (mounted.current && !controller.signal.aborted) setCloudError(failureMessage(failure));
    } finally {
      if (mounted.current) setCloudUploadProgress(null);
      if (cloudRequest.current === controller) cloudRequest.current = null;
      if (cloudOperation.current === operation) cloudOperation.current = null;
    }
  }
  useEffect(() => {
    if (!userId || transcript || !storedTranscriptLoaded || !cloud?.configured || cloud.status !== "idle" || cloudError || storedTranscriptError || automaticAttempt || transcriptionTooLong || transcriptionFile.size > cloud.maxUploadBytes) return;
    let cancelled = false;
    setAutomaticPending(true);
    void claimAutomaticTranscription(userId, take.id).then(claimed => {
      if (cancelled || !mounted.current) return;
      setAutomaticAttempt(automaticTranscriptionAttempt(userId, take.id));
      if (claimed && !cancelRequested.current && !currentTranscript.current) void generateTranscript();
    }).finally(() => { if (mounted.current) setAutomaticPending(false); });
    return () => { cancelled = true; };
  }, [take.id, userId, transcript, storedTranscriptLoaded, cloud?.configured, cloud?.status, cloudError, storedTranscriptError, automaticAttempt, transcriptionTooLong, transcriptionFile.size]);

  function retryTranscription() {
    if (!storedTranscriptLoaded || storedTranscriptError) setStoredTranscriptReload(value => value + 1);
    if (!cloud?.configured || !storedTranscriptLoaded || storedTranscriptError) setCloudReload(value => value + 1);
    else void generateTranscript();
  }

  async function cancelTranscription() {
    if (cancellingCloud) return;
    cancelRequested.current = true;
    if (userId) { markAutomaticTranscription(userId, take.id, "cancelled"); setAutomaticAttempt("cancelled"); }
    setAutomaticPending(false);
    cloudEpoch.current++;
    cloudPoll.current?.abort();
    setCancellingCloud(true);
    cloudRequest.current?.abort();
    setCloudUploadProgress(null);
    try {
      await cloudOperation.current?.catch(() => {});
      await deleteCloudTranscription(
        take.id,
        () => tokenGetter.current(),
        undefined,
        userId ?? undefined,
      );
      if (!mounted.current) return;
      setCloud({
        configured: true,
        status: "idle",
        maxUploadBytes: cloud?.maxUploadBytes ?? 0,
      });
      setCloudReload((value) => value + 1);
    } catch (error) {
      if (mounted.current) {
        setCloudError(failureMessage(error));
        setCloudReload((value) => value + 1);
      }
    } finally {
      if (mounted.current) setCancellingCloud(false);
    }
  }
  async function clearTranscript() {
    if (userId) { markAutomaticTranscription(userId, take.id, "removed"); setAutomaticAttempt("removed"); }
    cloudEpoch.current++;
    cloudPoll.current?.abort();
    setRemovingTranscript(true);
    try {
      if (cloud?.configured && cloud.status !== "idle")
        await deleteCloudTranscription(
          take.id,
          () => tokenGetter.current(),
          undefined,
          userId ?? undefined,
        );
      if (take.cloud) await persistStoredTranscript(null);
      deleteTranscript(take.id);
      currentTranscript.current = null;
      if (userId) clearCloudReplacement(userId, take.id);
      setTranscript(null);
      setEditing(null);
      setCloud(
        cloud
          ? {
              configured: cloud.configured,
              status: "idle",
              maxUploadBytes: cloud.maxUploadBytes,
              maxAudioSeconds: cloud.maxAudioSeconds,
            }
          : null,
      );
      setRemoveTranscript(false);
    } catch (error) {
      setRemoveTranscript(false);
      setError(failureMessage(error));
    } finally {
      setRemovingTranscript(false);
    }
  }
  useEffect(() => {
    if (!download?.error) setDismissedDownloadError("");
  }, [download?.error]);
  useEffect(() => {
    if (!following || !playing || !activeCue.current || !cueList.current)
      return;
    const pane = cueList.current,
      row = activeCue.current;
    const bounds = pane.getBoundingClientRect(),
      rowBounds = row.getBoundingClientRect();
    if (rowBounds.top < bounds.top || rowBounds.bottom > bounds.bottom)
      pane.scrollTop += rowBounds.top - bounds.top - 40;
  }, [currentCueId, following, playing]);

  function seek(seconds: number) {
    const value = Math.max(0, Math.min(duration, seconds));
    if (video.current) video.current.currentTime = value;
    positionRef.current = value;
    setPosition(value);
  }
  async function togglePlayback() {
    if (!video.current) return;
    setMediaError("");
    if (!video.current.paused) video.current.pause();
    else {
      try {
        await video.current.play();
      } catch {
        setMediaError(
          "Não foi possível reproduzir este vídeo. Tente baixar o arquivo original.",
        );
      }
    }
  }
  function changeOrientation(value: string) {
    // A pointer action can select the Radix tab on both press and focus before
    // React commits. Preserve the first request's playback intent.
    if (requestedOrientation.current === value) return;
    requestedOrientation.current = value as Orientation;
    resumeAfterSwitch.current = Boolean(video.current && !video.current.paused);
    positionRef.current = video.current?.currentTime ?? position;
    video.current?.pause();
    setPlaying(false);
    setMediaDuration(0);
    setMediaError("");
    setOrientation(value as Orientation);
  }
  function persistTranscript(next: Transcript) {
    const saved = saveTranscript(take.id, next);
    setTranscript(saved);
    currentTranscript.current = saved;
    if (take.cloud) setStoredTranscriptStatus("Alterações salvas neste dispositivo. Envie a transcrição para a nuvem.");
    setEditing(null);
    setQuery("");
    setError("");
  }
  function saveCorrection() {
    if (!transcript || !editing) return;
    try {
      persistTranscript(
        updateTranscriptCue(transcript, editing.id, editing.text),
      );
      trackCreatorEvent('transcript_corrected');
    } catch (error) {
      setError(failureMessage(error));
    }
  }
  function downloadTranscript(format: "vtt" | "srt" | "txt") {
    if (!transcript) return;
    try {
      const blob = new Blob([exportTranscript(transcript, format)], {
        type:
          format === "vtt"
            ? "text/vtt;charset=utf-8"
            : "text/plain;charset=utf-8",
      });
      const url = URL.createObjectURL(blob),
        anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${take.name.replace(/[/\\]/g, "-")}.${format}`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      trackCreatorEvent('transcript_downloaded', { format });
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setError(failureMessage(error));
    }
  }
  function addMarker() {
    if (!note.trim()) return;
    try {
      setReview(
        saveReview(take.id, {
          version: 1,
          markers: [
            ...review.markers,
            { id: crypto.randomUUID(), time: position, text: note.trim() },
          ],
        }),
      );
      setNote("");
      setError("");
    } catch (error) {
      setError(failureMessage(error));
    }
  }

  const transcriptionProblem = cloudError || storedTranscriptError || (cloud?.status === "error" ? cloud.error || "Não foi possível transcrever esta gravação." : "");
  const tooLarge = Boolean(cloud?.configured && transcriptionFile.size > cloud.maxUploadBytes);
  const transcriptionLoading = cloudBusy || (!transcriptionProblem && !transcriptionTooLong && !tooLarge && (!cloud || !storedTranscriptLoaded || (cloud.configured && cloud.status === "idle" && !automaticAttempt)));
  const transcriptionMessage = cancellingCloud ? "Cancelando transcrição…"
    : cloudUploadProgress !== null ? `Enviando gravação · ${Math.round(cloudUploadProgress)}%`
    : cloud?.status === "queued" ? "Na fila para transcrição…"
    : cloud?.status === "processing" ? "Transcrevendo sua gravação…"
    : transcriptionProblem || (transcriptionTooLong && cloud?.configured ? "Esta gravação excede o limite de duas horas para transcrição."
      : tooLarge ? "Esta gravação excede o limite de tamanho para transcrição."
      : cloud?.noSpeech ? "Nenhuma fala foi encontrada nesta gravação."
      : cloud?.configured === false ? "Transcrição indisponível no momento."
      : automaticAttempt === "cancelled" ? "Transcrição cancelada."
      : automaticAttempt === "removed" ? "Sem transcrição."
      : cloud?.status === "uploading" || automaticAttempt === "started" && cloud?.status === "idle" ? "A transcrição não foi concluída."
      : "Preparando transcrição…");
  const canRetryTranscription = !transcriptionLoading && !transcriptionTooLong && !tooLarge && !cloud?.noSpeech;

  return (
    <section
      className="recording-detail"
      aria-label={`Gravação ${take.name}`}
      data-testid="recording-detail"
    >
      <header className="recording-detail-heading">
        <div className="recording-heading-title">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Voltar para gravações"
            disabled={anyDownloadBusy}
            onClick={onBack}
          >
            <ArrowLeft size={19} />
          </Button>
          <div>
            <h1>
              {take.name}
              <IconButton label="Renomear gravação" onClick={onRename}>
                <Pencil size={14} />
              </IconButton>
            </h1>
          </div>
        </div>
        <div className="recording-heading-actions">
          {editing && <span className="recording-editing-status" role="status">Correção não salva</span>}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button disabled={anyDownloadBusy} aria-label="Baixar gravação">
                <Download size={15} />
                {download?.busy ? download.label : "Baixar vídeo"}
                <ChevronDown size={13} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => onDownload(file)}>
                Baixar {orientation === "landscape" ? "horizontal" : "vertical"}{" "}
                em MP4
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <a
                  href={result.landscape.url}
                  download={result.landscape.fileName}
                  onClick={event => void downloadOriginal(event, 'landscape')}
                >
                  Original horizontal
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a
                  href={result.portrait.url}
                  download={result.portrait.fileName}
                  onClick={event => void downloadOriginal(event, 'portrait')}
                >
                  Original vertical
                </a>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      {storageActions}
      {take.cloud && transcript && <div className="cloud-transcript-sync"><span role="status">{storedTranscriptStatus || 'Carregando transcrição da nuvem…'}</span>{transcript && <Button size="sm" variant="outline" disabled={savingStoredTranscript || storedTranscriptVersion === null || cloudBusy} onClick={() => void persistStoredTranscript().catch(() => undefined)}>{savingStoredTranscript ? 'Salvando…' : 'Salvar transcrição na nuvem'}</Button>}</div>}
      {(error || visibleDownloadError) && (
        <div className="recording-detail-error" role="alert">
          <span>{error || visibleDownloadError}</span>
          <IconButton
            label="Fechar aviso da gravação"
            onClick={() => {
              setError("");
              setDismissedDownloadError(download?.error ?? "");
            }}
          >
            <X size={15} />
          </IconButton>
        </div>
      )}
      <div className="recording-editor-grid">
        <Tabs
          value={leftTab}
          onValueChange={setLeftTab}
          className="recording-transcript-pane"
        >
          <div className="recording-transcript-heading">
            <TabsList
              aria-label="Conteúdo da gravação"
              className="recording-content-tabs"
            >
              <TabsTrigger value="transcript">
                <FileText size={15} />
                Transcrição
              </TabsTrigger>
              <TabsTrigger value="markers">
                <BookmarkPlus size={15} />
                Marcadores
                {review.markers.length > 0 && (
                  <span className="ui-tabs-count">{review.markers.length}</span>
                )}
              </TabsTrigger>
            </TabsList>
            {transcript && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton label="Opções da transcrição">
                  <MoreHorizontal size={18} />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={!transcript}
                  onSelect={() => downloadTranscript("txt")}
                >
                  Baixar texto (.txt)
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!transcript}
                  onSelect={() => downloadTranscript("srt")}
                >
                  Baixar legendas (.srt)
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!transcript}
                  onSelect={() => downloadTranscript("vtt")}
                >
                  Baixar legendas (.vtt)
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  destructive
                  disabled={!transcript}
                  onSelect={() => setRemoveTranscript(true)}
                >
                  Remover transcrição
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            )}
          </div>
          <TabsContent
            value="transcript"
            className="recording-transcript-content"
          >
            {(!transcript || cloudBusy || cloudError || storedTranscriptError || cloud?.status === "error") && (
              <div className={`cloud-transcription-status ${transcript ? "" : "is-empty"}`} role={transcriptionProblem ? "alert" : "status"} data-testid="transcription-status">
                <div>{transcriptionLoading && <LoaderCircle className="spin" size={16} />}<p>{transcriptionMessage}</p></div>
                {cloudBusy ? <Button variant="ghost" size="sm" disabled={cancellingCloud} onClick={() => void cancelTranscription()}>Cancelar transcrição</Button>
                  : canRetryTranscription && <Button variant="secondary" size="sm" onClick={retryTranscription}>{cloud?.configured && storedTranscriptLoaded ? "Tentar novamente" : "Verificar novamente"}</Button>}
              </div>
            )}
            {transcript ? (
              <>
                <div className="transcript-search">
                  <Search size={15} />
                  <Input
                    aria-label="Buscar na transcrição"
                    placeholder="Buscar uma palavra ou ideia…"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                  {query && (
                    <IconButton
                      label="Limpar busca na transcrição"
                      onClick={() => setQuery("")}
                    >
                      <X size={13} />
                    </IconButton>
                  )}
                </div>
                <div className="transcript-summary">
                  <span>
                    {query
                      ? `${filteredCues.length} ${filteredCues.length === 1 ? "trecho encontrado" : "trechos encontrados"}`
                      : `${transcript.cues.length} trechos`}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-pressed={following}
                    onClick={() => setFollowing(!following)}
                  >
                    <ArrowDownToLine size={12} />
                    Acompanhar
                  </Button>
                </div>
                <div className="transcript-cues" ref={cueList}>
                  {filteredCues.length === 0 && (
                    <p className="transcript-no-results">
                      Nenhum trecho encontrado. Tente outra palavra.
                    </p>
                  )}
                  {filteredCues.map((cue) => (
                    <article
                      key={cue.id}
                      data-testid="transcript-cue"
                      className={`transcript-cue ${currentCueId === cue.id ? "is-current" : ""}`}
                      ref={(element) => {
                        if (currentCueId === cue.id)
                          activeCue.current = element;
                      }}
                    >
                      <Button
                        variant="ghost"
                        size="sm"
                        className="transcript-cue-time"
                        aria-label={`Ir para ${clock(cue.start)}`}
                        onClick={() => seek(cue.start)}
                      >
                        {clock(cue.start)}
                      </Button>
                      {editing?.id === cue.id ? (
                        <div className="transcript-correction">
                          <Textarea
                            autoFocus
                            aria-label="Corrigir texto do trecho"
                            value={editing.text}
                            maxLength={10000}
                            onChange={(event) =>
                              setEditing({
                                ...editing,
                                text: event.target.value,
                              })
                            }
                          />
                          <div>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setEditing(null)}
                            >
                              Cancelar
                            </Button>
                            <Button
                              size="sm"
                              disabled={!editing.text.trim()}
                              onClick={saveCorrection}
                            >
                              Salvar correção
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <>
                          {wordsByCue.has(cue.id) ? (
                            <p className="transcript-word-text">
                              {wordsByCue.get(cue.id)!.map((word, index) => (
                                <span key={word.id}>
                                  <Button
                                    variant="ghost"
                                    className={`transcript-word ${position >= word.start && position < word.end ? "is-current-word" : ""}`}
                                    aria-label={`Ir para palavra: ${word.text}`}
                                    onClick={() => seek(word.start)}
                                  >
                                    <MatchedText
                                      text={word.text}
                                      query={query.trim()}
                                    />
                                  </Button>
                                  {index < wordsByCue.get(cue.id)!.length - 1
                                    ? " "
                                    : ""}
                                </span>
                              ))}
                            </p>
                          ) : (
                            <Button
                              variant="ghost"
                              className="transcript-cue-text"
                              onClick={() => seek(cue.start)}
                              aria-label={`Ir para trecho: ${cue.text}`}
                            >
                              <MatchedText
                                text={cue.text}
                                query={query.trim()}
                              />
                            </Button>
                          )}
                          <IconButton
                            disabled={Boolean(editing) || cloudBusy}
                            label={`Corrigir trecho em ${clock(cue.start)}`}
                            className="transcript-cue-edit"
                            onClick={() => {
                              video.current?.pause();
                              setEditing({ id: cue.id, text: cue.text });
                            }}
                          >
                            <Pencil size={13} />
                          </IconButton>
                        </>
                      )}
                    </article>
                  ))}
                </div>
              </>
            ) : (
              null
            )}
          </TabsContent>
          <TabsContent value="markers" className="recording-markers-content">
            <form
              className="recording-marker-form"
              onSubmit={(event) => {
                event.preventDefault();
                addMarker();
              }}
            >
              <span>
                Adicionar em <strong>{clock(position)}</strong>
              </span>
              <Textarea
                aria-label="Nota do marcador"
                placeholder="Uma boa abertura, um trecho para compartilhar…"
                maxLength={1000}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
              <Button
                type="submit"
                size="sm"
                variant="secondary"
                disabled={!note.trim()}
              >
                <BookmarkPlus size={14} />
                Adicionar marcador
              </Button>
            </form>
            <div className="recording-marker-list">
              {review.markers.length === 0 ? (
                <p>Seus marcadores vão aparecer aqui.</p>
              ) : (
                review.markers.map((marker) => (
                  <article key={marker.id}>
                    <Button
                      variant="ghost"
                      className="recording-marker-seek"
                      onClick={() => seek(marker.time)}
                    >
                      <span>{clock(marker.time)}</span>
                      <p>{marker.text}</p>
                    </Button>
                    <IconButton
                      label={`Excluir marcador em ${clock(marker.time)}`}
                      onClick={() => {
                        try {
                          setReview(
                            saveReview(take.id, {
                              version: 1,
                              markers: review.markers.filter(
                                (item) => item.id !== marker.id,
                              ),
                            }),
                          );
                        } catch (error) {
                          setError(failureMessage(error));
                        }
                      }}
                    >
                      <Trash2 size={13} />
                    </IconButton>
                  </article>
                ))
              )}
            </div>
          </TabsContent>
        </Tabs>
        <div className="recording-video-pane">
          <div className="recording-video-heading">
            <h2>Vídeo</h2>
            <Tabs value={orientation} onValueChange={changeOrientation}>
              <TabsList aria-label="Formato do vídeo">
                <TabsTrigger value="landscape">
                  <Monitor size={14} />
                  Horizontal
                </TabsTrigger>
                <TabsTrigger value="portrait">
                  <Smartphone size={14} />
                  Vertical
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          <div className={`recording-player is-${orientation}`} ref={player}>
            <div className="recording-video-stage">
              <video
                ref={video}
                key={orientation}
                src={file.url}
                playsInline
                preload="auto"
                muted={muted}
                tabIndex={0}
                aria-label={`Reprodutor ${orientation === "landscape" ? "horizontal" : "vertical"}`}
                data-testid={`recording-video-${orientation}`}
                onLoadedMetadata={(event) => {
                  const element = event.currentTarget;
                  const length =
                    Number.isFinite(element.duration) && element.duration > 0
                      ? element.duration
                      : take.durationMs / 1000;
                  setMediaDuration(length);
                  element.currentTime = Math.min(positionRef.current, length);
                  element.playbackRate = Number(speed);
                }}
                onLoadedData={() => {
                  if (resumeAfterSwitch.current) {
                    resumeAfterSwitch.current = false;
                    void video.current
                      ?.play()
                      .catch(() =>
                        setMediaError("Clique em reproduzir para continuar."),
                      );
                  }
                }}
                onTimeUpdate={(event) => {
                  positionRef.current = event.currentTarget.currentTime;
                  setPosition(event.currentTarget.currentTime);
                }}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onEnded={() => setPlaying(false)}
                crossOrigin={take.cloud && !file.url.startsWith('blob:') ? 'anonymous' : undefined}
                onError={() => { if (take.cloud) void renewMedia(); else setMediaError('Não foi possível carregar a prévia. O arquivo original continua disponível para download.'); }}
                onClick={() => void togglePlayback()}
                onKeyDown={(event) => {
                  if (event.key === " ") {
                    event.preventDefault();
                    void togglePlayback();
                  }
                }}
              />
              {!playing && !mediaError && (
                <Button
                  className="recording-center-play"
                  aria-label="Reproduzir vídeo"
                  onClick={() => void togglePlayback()}
                >
                  <Play size={25} fill="currentColor" />
                </Button>
              )}
              {mediaError && (
                <p className="recording-player-error" role="alert">
                  {mediaError}
                </p>
              )}
            </div>
            <div className="recording-player-controls">
              <div className="recording-player-seek">
                <span>{clock(position)}</span>
                <Slider
                  label="Posição do vídeo"
                  min={0}
                  max={Math.max(duration, 0.01)}
                  step={0.01}
                  value={[position]}
                  onValueChange={([next]) => seek(next)}
                  disabled={!duration}
                />
                <span>{clock(duration)}</span>
              </div>
              <div className="recording-player-buttons">
                <div>
                  <IconButton
                    label="Voltar 5 segundos"
                    onClick={() => seek(position - 5)}
                  >
                    <SkipBack size={16} />
                  </IconButton>
                  <IconButton
                    label={playing ? "Pausar vídeo" : "Reproduzir vídeo"}
                    className="recording-transport-play"
                    onClick={() => void togglePlayback()}
                  >
                    {playing ? (
                      <Pause size={18} fill="currentColor" />
                    ) : (
                      <Play size={18} fill="currentColor" />
                    )}
                  </IconButton>
                  <IconButton
                    label="Avançar 5 segundos"
                    onClick={() => seek(position + 5)}
                  >
                    <SkipForward size={16} />
                  </IconButton>
                </div>
                <div>
                  <IconButton label="Marcar momento" onClick={() => { video.current?.pause(); setLeftTab("markers"); }}>
                    <BookmarkPlus size={16} />
                  </IconButton>
                  <IconButton
                    label={muted ? "Ativar som do vídeo" : "Silenciar vídeo"}
                    onClick={() => setMuted(!muted)}
                  >
                    {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
                  </IconButton>
                  <Select
                    label="Velocidade de reprodução"
                    value={speed}
                    options={["0.5", "0.75", "1", "1.25", "1.5", "2"].map(
                      (value) => ({
                        value,
                        label: `${value.replace(".", ",")}×`,
                      }),
                    )}
                    onValueChange={(value) => {
                      setSpeed(value);
                      if (video.current)
                        video.current.playbackRate = Number(value);
                    }}
                  />
                  <IconButton
                    label="Tela cheia"
                    onClick={() => {
                      if (document.fullscreenElement)
                        void document.exitFullscreen().catch(() => {});
                      else
                        void player.current
                          ?.requestFullscreen()
                          .catch(() =>
                            setMediaError(
                              "Tela cheia indisponível neste navegador.",
                            ),
                          );
                    }}
                  >
                    <Maximize size={16} />
                  </IconButton>
                </div>
              </div>
            </div>
          </div>
          <div className="recording-video-meta">
            <span>
              {new Intl.DateTimeFormat("pt-BR", {
                day: "numeric",
                month: "long",
                year: "numeric",
              }).format(take.createdAt)}
            </span>
            <span>
              {clock(duration)}
              <i />
              {(file.size / 1024 / 1024).toFixed(1)} MB
              <i />
              {orientation === "landscape" ? "16:9" : "9:16"}
            </span>
          </div>
          {result.warnings.length > 0 && (
            <details className="recording-detail-warnings">
              <summary>Detalhes da gravação</summary>
              {result.warnings.map((warning, index) => (
                <p key={index}>{warning}</p>
              ))}
            </details>
          )}
        </div>
      </div>
      {removeTranscript && (
        <AlertDialog
          onClose={() => setRemoveTranscript(false)}
          title="Remover a transcrição?"
          description={take.cloud ? "O texto e suas correções serão removidos deste dispositivo e da cópia na nuvem." : "O texto e suas correções serão removidos deste navegador."}
          actionLabel="Remover transcrição"
          pending={removingTranscript}
          onConfirm={() => void clearTranscript()}
        />
      )}
    </section>
  );
}
