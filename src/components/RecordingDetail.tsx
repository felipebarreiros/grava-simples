import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@clerk/react";
import {
  ArrowLeft,
  ArrowDownToLine,
  BookmarkPlus,
  Check,
  ChevronDown,
  Download,
  FileText,
  Headphones,
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
  importTranscriptFile,
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
import { IconButton, Modal } from "./StudioUi";
import {
  approveCloudReplacement,
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
  const [error, setError] = useState("");
  const [dismissedDownloadError, setDismissedDownloadError] = useState("");
  const [transcript, setTranscript] = useState(() => loadTranscript(take.id));
  const [review, setReview] = useState(() => loadReview(take.id));
  const [pendingImport, setPendingImport] = useState<Transcript | null>(null);
  const [removeTranscript, setRemoveTranscript] = useState(false);
  const [query, setQuery] = useState("");
  const [following, setFollowing] = useState(true);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(
    null,
  );
  const [note, setNote] = useState("");
  const [leftTab, setLeftTab] = useState("transcript");
  const [importing, setImporting] = useState(false);
  const [cloud, setCloud] = useState<CloudTranscription | null>(null);
  const [cloudError, setCloudError] = useState("");
  const [cloudUploadProgress, setCloudUploadProgress] = useState<number | null>(
    null,
  );
  const [cloudDialog, setCloudDialog] = useState(false);
  const [removingTranscript, setRemovingTranscript] = useState(false);
  const [cancellingCloud, setCancellingCloud] = useState(false);
  const [cloudReload, setCloudReload] = useState(0);
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
  const upload = useRef<HTMLInputElement>(null);
  const cueList = useRef<HTMLDivElement>(null);
  const activeCue = useRef<HTMLElement | null>(null);
  const positionRef = useRef(0);
  const resumeAfterSwitch = useRef(false);
  const requestedOrientation = useRef<Orientation>("landscape");
  const mounted = useRef(true);
  const duration = mediaDuration || take.durationMs / 1000;
  const file = result[orientation];
  const download = downloads[`${take.id}-${orientation}`];
  const visibleDownloadError =
    download?.error !== dismissedDownloadError ? download?.error : "";
  const anyDownloadBusy = Object.values(downloads).some((item) => item.busy);
  const cloudBusy =
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
          (!currentTranscript.current ||
            (userId &&
              shouldReplaceCloudTranscript(userId, take.id, next.jobId)))
        ) {
          const saved = saveTranscript(take.id, next.transcript);
          currentTranscript.current = saved;
          setTranscript(saved);
          if (userId) clearCloudReplacement(userId, take.id);
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
  }, [take.id, userId, cloudReload]);

  async function generateTranscript() {
    if (!userId || cloudBusy) return;
    setCloudDialog(false);
    setCloudError("");
    setCloudUploadProgress(0);
    cloudEpoch.current++;
    cloudPoll.current?.abort();
    cancelRequested.current = false;
    const controller = new AbortController();
    cloudRequest.current = controller;
    const operation = (async () => {
      if (cloud && ["completed", "error", "uploading"].includes(cloud.status))
        await deleteCloudTranscription(
          take.id,
          () => tokenGetter.current(),
          controller.signal,
          userId,
        );
      controller.signal.throwIfAborted();
      approveCloudReplacement(userId, take.id);
      const next = await startCloudTranscription({
        recordingId: take.id,
        userId,
        file: transcriptionFile,
        getToken: () => tokenGetter.current(),
        signal: controller.signal,
        onProgress: (percentage) => {
          if (mounted.current && !cancelRequested.current)
            setCloudUploadProgress(percentage);
        },
      });
      if (!cancelRequested.current)
        approveCloudReplacement(userId, take.id, next.jobId);
      return next;
    })();
    cloudOperation.current = operation;
    try {
      const next = await operation;
      if (!mounted.current || cancelRequested.current) return;
      setCloud(next);
      setCloudReload((value) => value + 1);
    } catch (error) {
      if (mounted.current && !controller.signal.aborted)
        setCloudError(failureMessage(error));
    } finally {
      if (mounted.current) setCloudUploadProgress(null);
      if (cloudRequest.current === controller) cloudRequest.current = null;
      if (cloudOperation.current === operation) cloudOperation.current = null;
    }
  }

  async function cancelTranscription() {
    if (cancellingCloud) return;
    cancelRequested.current = true;
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
    setEditing(null);
    setQuery("");
    setError("");
  }
  async function importFile(fileToImport: File) {
    setImporting(true);
    setError("");
    try {
      const next = await importTranscriptFile(
        fileToImport,
        duration || undefined,
      );
      if (!mounted.current) return;
      if (transcript) setPendingImport(next);
      else persistTranscript(next);
    } catch (error) {
      if (mounted.current) setError(failureMessage(error));
    } finally {
      if (mounted.current) setImporting(false);
    }
  }
  function saveCorrection() {
    if (!transcript || !editing) return;
    try {
      persistTranscript(
        updateTranscriptCue(transcript, editing.id, editing.text),
      );
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

  return (
    <section
      className="recording-detail"
      aria-label={`Gravação ${take.name}`}
      data-testid="recording-detail"
    >
      <Input
        hidden
        type="file"
        ref={upload}
        accept=".srt,.vtt"
        data-testid="transcript-file-input"
        aria-label="Importar arquivo de transcrição"
        onChange={(event) => {
          const selected = event.target.files?.[0];
          event.target.value = "";
          if (selected) void importFile(selected);
        }}
      />
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
            <p className="recording-breadcrumb">
              {projectName}
              <span>/</span>Gravações
            </p>
            <h1>
              {take.name}
              <IconButton label="Renomear gravação" onClick={onRename}>
                <Pencil size={14} />
              </IconButton>
            </h1>
          </div>
        </div>
        <div className="recording-heading-actions">
          <span
            className={`recording-saved ${editing ? "has-draft" : ""}`}
            role="status"
          >
            <Check size={13} />
            {editing ? "Correção não salva" : "Salvo neste navegador"}
          </span>
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
                >
                  Original horizontal
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a
                  href={result.portrait.url}
                  download={result.portrait.fileName}
                >
                  Original vertical
                </a>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton label="Opções da transcrição">
                  <MoreHorizontal size={18} />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={
                    cloudBusy ||
                    Boolean(editing) ||
                    !cloud?.configured ||
                    transcriptionTooLong
                  }
                  onSelect={() => setCloudDialog(true)}
                >
                  <Headphones size={14} />
                  Gerar transcrição automática
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={importing || cloudBusy}
                  onSelect={() => upload.current?.click()}
                >
                  <Upload size={14} />
                  Importar SRT ou VTT
                </DropdownMenuItem>
                <DropdownMenuSeparator />
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
          </div>
          <TabsContent
            value="transcript"
            className="recording-transcript-content"
          >
            {(cloudBusy ||
              cloudError ||
              cloud?.status === "error" ||
              cloud?.noSpeech) && (
              <div className="cloud-transcription-status" role="status">
                <div>
                  {cloudBusy && <LoaderCircle className="spin" size={15} />}
                  <p>
                    {cancellingCloud
                      ? "Cancelando transcrição…"
                      : cloudUploadProgress !== null
                        ? `Enviando gravação · ${Math.round(cloudUploadProgress)}%`
                        : cloud?.status === "queued"
                          ? "Na fila para transcrição…"
                          : cloud?.status === "processing"
                            ? "Transcrevendo sua gravação…"
                            : cloud?.noSpeech
                              ? "Nenhuma fala foi encontrada nesta gravação."
                              : cloudError ||
                                cloud?.error ||
                                "Não foi possível transcrever. Tente novamente."}
                  </p>
                </div>
                {cloudBusy ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={cancellingCloud}
                    onClick={() => void cancelTranscription()}
                  >
                    Cancelar transcrição
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setCloudReload((value) => value + 1)}
                  >
                    Verificar novamente
                  </Button>
                )}
                {cloudBusy && (
                  <span>
                    Você pode continuar assistindo. O processamento continua
                    após o envio, mesmo ao sair desta página.
                  </span>
                )}
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
                      : `${transcript.cues.length} trechos · ${transcript.origin === "automatic" ? "transcrição automática" : "legenda importada"}`}
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
                          <p>A correção altera o texto e as legendas.</p>
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
                <footer className="transcript-footer">
                  <span title={transcript.sourceName}>
                    {transcript.sourceName}
                  </span>
                  <span>Clique em um trecho para ir ao vídeo.</span>
                </footer>
              </>
            ) : (
              <div className="transcript-empty">
                <div className="transcript-empty-art" aria-hidden="true">
                  <Headphones size={28} strokeWidth={1.3} />
                  <div>
                    {[10, 19, 28, 17, 34, 23, 13, 29, 21, 12, 25, 16].map(
                      (height, index) => (
                        <i key={index} style={{ height }} />
                      ),
                    )}
                  </div>
                </div>
                <span className="recording-eyebrow">
                  DO VÍDEO PARA AS PALAVRAS
                </span>
                <h2>
                  Cada palavra,
                  <br />
                  no seu lugar.
                </h2>
                <p>
                  Encontre uma ideia, acompanhe a fala e revise o texto sem sair
                  do vídeo.
                </p>
                {cloud?.configured && (
                  <Button
                    disabled={cloudBusy || importing || transcriptionTooLong}
                    onClick={() => setCloudDialog(true)}
                  >
                    <Headphones size={15} />
                    {cloud?.status === "error"
                      ? "Tentar transcrição novamente"
                      : "Gerar transcrição"}
                  </Button>
                )}
                <Button
                  variant="secondary"
                  disabled={importing || cloudBusy}
                  onClick={() => upload.current?.click()}
                >
                  <Upload size={15} />
                  {importing ? "Importando…" : "Importar transcrição"}
                </Button>
                <span className="transcript-import-formats">
                  SRT ou VTT · até 5 MB
                </span>
                <div className="transcript-availability">
                  <span />
                  {transcriptionTooLong && cloud?.configured
                    ? "A transcrição automática aceita gravações de até duas horas. Você pode importar uma legenda para este vídeo."
                    : cloud?.configured
                      ? "Gere a transcrição com envio seguro da gravação ou importe uma legenda que você já tem."
                      : "A transcrição automática ainda não está disponível. Importe uma legenda para começar."}
                </div>
              </div>
            )}
          </TabsContent>
          <TabsContent value="markers" className="recording-markers-content">
            <div className="recording-marker-intro">
              <h2>Guarde os bons momentos.</h2>
              <p>Marque ideias, ajustes e trechos para revisitar.</p>
            </div>
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
            <div>
              <span className="recording-eyebrow">SUA GRAVAÇÃO</span>
              <h2>Uma ideia. Dois formatos.</h2>
            </div>
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
                onError={() =>
                  setMediaError(
                    "Não foi possível carregar a prévia. O arquivo original continua disponível para download.",
                  )
                }
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
          <div className="recording-review-hint">
            <BookmarkPlus size={18} />
            <div>
              <h3>Encontrou um momento que vale guardar?</h3>
              <p>
                Adicione um marcador e volte direto para ele quando precisar.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                video.current?.pause();
                setLeftTab("markers");
              }}
            >
              Marcar momento
            </Button>
          </div>
          <div className="recording-detail-footnote">
            <span>
              <Check size={12} />
              Dois formatos salvos
            </span>
            <p>
              As correções da transcrição aparecem nas legendas exportadas. O
              vídeo mantém a gravação original.
            </p>
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
      {cloudDialog && (
        <Modal
          title="Transcrever gravação"
          description="Sua gravação será enviada para transcrição."
          onClose={() => setCloudDialog(false)}
        >
          <div className="cloud-transcription-disclosure">
            <p>
              Vamos enviar um dos formatos da gravação (
              {(transcriptionFile.size / 1024 / 1024).toFixed(1)} MB) para
              processamento pela AssemblyAI. A transcrição inclui os tempos das
              palavras.
            </p>
            <p>
              Nesta versão, aceitamos gravações de até duas horas e 512 MB. O
              serviço processa até as primeiras duas horas de áudio.
            </p>
            <p>
              A cópia temporária fica em armazenamento privado e a exclusão é
              solicitada ao concluir ou cancelar. Envios abandonados são
              removidos pela limpeza programada.
            </p>
            {transcript && (
              <p>
                O texto atual será substituído quando a nova transcrição ficar
                pronta.
              </p>
            )}
            <Button
              disabled={!cloud?.configured || cloudBusy || transcriptionTooLong}
              onClick={() => void generateTranscript()}
            >
              <Headphones size={15} />
              Enviar e transcrever
            </Button>
          </div>
        </Modal>
      )}
      {pendingImport && (
        <AlertDialog
          onClose={() => setPendingImport(null)}
          title="Substituir a transcrição?"
          description="A legenda importada vai substituir o texto atual e suas correções nesta gravação."
          actionLabel="Substituir transcrição"
          onConfirm={() => {
            try {
              persistTranscript(pendingImport);
              setPendingImport(null);
            } catch (error) {
              setError(failureMessage(error));
            }
          }}
        />
      )}
      {removeTranscript && (
        <AlertDialog
          onClose={() => setRemoveTranscript(false)}
          title="Remover a transcrição?"
          description="O texto e suas correções serão removidos deste navegador. Você pode importar a legenda novamente."
          actionLabel="Remover transcrição"
          pending={removingTranscript}
          onConfirm={() => void clearTranscript()}
        />
      )}
    </section>
  );
}
