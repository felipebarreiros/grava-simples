import { useEffect, useRef, useState } from "react";
import {
  ArrowDown, ArrowLeft, ArrowUp, BookOpen, Check, ChevronDown,
  ChevronRight, ExternalLink, FileVideo, LoaderCircle, LogOut,
  Monitor, MoreHorizontal, Pencil, Plus, RefreshCw, Smartphone, Upload,
} from "lucide-react";
import type { Orientation, RecordingFile, RecordingResult } from "../media/types";
import {
  createHotmartCourse,
  createHotmartModule,
  createHotmartMembership,
  disconnectHotmart,
  getHotmartConnection,
  getHotmartCourse,
  listHotmartCourses,
  listHotmartMemberships,
  publishHotmartVideo,
  renameHotmartModule,
  reorderHotmartModules,
  startHotmartConnection,
} from "../hotmart/client";
import type {
  HotmartConnection,
  HotmartCourse,
  HotmartCourseDetail,
  HotmartMembership,
} from "../hotmart/types";
import { Button } from "./ui/button";
import { Input, Textarea } from "./ui/input";
import { Select } from "./Select";
import { IconButton, Modal } from "./StudioUi";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { hotmartDraftKey, hotmartResumeKey, readHotmartDraft, type HotmartDraft } from "./hotmartDraft";
import "./HotmartPublishDialog.css";

interface Props {
  recordingId: string;
  cloudRecordingId?: string;
  recordingName: string;
  projectName: string;
  result: RecordingResult;
  initialOrientation: Orientation;
  preparedFiles?: Partial<Record<Orientation, RecordingFile>>;
  getToken: () => Promise<string | null>;
  ownerId: string;
  onClose: () => void;
}

type View = "upload" | "course" | "membership" | "modules" | "module-create" | "module-rename";

type Phase = "preparing" | "uploading" | "processing" | "creating";
const message = (error: unknown) =>
  error instanceof Error ? error.message : "Não foi possível concluir. Tente novamente.";
export function HotmartPublishDialog({
  recordingId, cloudRecordingId, recordingName, projectName, result, initialOrientation,
  preparedFiles, getToken, ownerId, onClose,
}: Props) {
  const [initial] = useState(() => readHotmartDraft(ownerId, recordingId, recordingName, initialOrientation));
  const [connection, setConnection] = useState<HotmartConnection | null>(null);
  const [courses, setCourses] = useState<HotmartCourse[]>([]);
  const [memberships, setMemberships] = useState<HotmartMembership[]>([]);
  const [detail, setDetail] = useState<HotmartCourseDetail | null>(null);
  const [courseId, setCourseId] = useState(initial.courseId);
  const [moduleId, setModuleId] = useState(initial.moduleId);
  const [orientation, setOrientation] = useState<Orientation>(initial.orientation);
  const [title, setTitle] = useState(initial.title);
  const [description, setDescription] = useState(initial.description);
  const [publish, setPublish] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingCourse, setLoadingCourse] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [view, setView] = useState<View>("upload");
  const [courseName, setCourseName] = useState("");
  const [courseDescription, setCourseDescription] = useState("");
  const [coursePrice, setCoursePrice] = useState("");
  const [membershipSlug, setMembershipSlug] = useState("");
  const [membershipName, setMembershipName] = useState("");
  const [newMembershipSlug, setNewMembershipSlug] = useState("");
  const [moduleName, setModuleName] = useState("");
  const [renamingModule, setRenamingModule] = useState<string | null>(null);
  const [renamedModule, setRenamedModule] = useState("");
  const [expandedModules, setExpandedModules] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<{ phase: Phase; percentage?: number } | null>(null);
  const [success, setSuccess] = useState<{ lessonId: string; url: string; published: boolean } | null>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const tokenGetter = useRef(getToken);
  tokenGetter.current = getToken;
  const mounted = useRef(true);
  const file = result[orientation];
  const busy = progress !== null;
  const disabled = busy || mutating || connecting;
  const selectedModule = detail?.modules.find((module) => module.id === moduleId);
  const selectedCourse = courses.find((course) => course.id === courseId);
  function showFailure(failure: unknown) {
    setError(message(failure));
    if (failure && typeof failure === "object" && "status" in failure && failure.status === 401) {
      setConnection((current) => current ? { ...current, connected: false } : current);
    }
  }

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; activeRequest.current?.abort(); };
  }, []);

  useEffect(() => {
    if (success) return;
    try {
      const draft: HotmartDraft = { title, description, orientation, courseId, moduleId };
      sessionStorage.setItem(hotmartDraftKey(ownerId, recordingId), JSON.stringify(draft));
    } catch { /* The publishing flow remains usable when tab storage is full. */ }
  }, [ownerId, recordingId, title, description, orientation, courseId, moduleId, success]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void (async () => {
      try {
        const next = await getHotmartConnection(() => tokenGetter.current(), controller.signal);
        if (controller.signal.aborted) return;
        setConnection(next);
        if (!next.connected && new URLSearchParams(location.search).get("hotmart") === "error") {
          setError("Não foi possível conectar sua conta. Tente entrar na Hotmart novamente.");
        }
        if (next.connected) {
          const [items, areas] = await Promise.all([
            listHotmartCourses(() => tokenGetter.current(), controller.signal),
            listHotmartMemberships(() => tokenGetter.current(), controller.signal),
          ]);
          if (controller.signal.aborted) return;
          setCourses(items);
          setMemberships(areas);
          setMembershipSlug((current) => areas.some((area) => area.slug === current) ? current : (areas[0]?.slug || ""));
          setCourseId((current) => items.some((course) => course.id === current) ? current : (items[0]?.id || ""));
        }
      } catch (failure) {
        if (!controller.signal.aborted) showFailure(failure);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [reload]);

  useEffect(() => {
    if (!connection?.connected || !courseId) { setDetail(null); return; }
    const controller = new AbortController();
    setDetail(null);
    setLoadingCourse(true);
    setError("");
    void getHotmartCourse(courseId, () => tokenGetter.current(), controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setDetail(next);
        setModuleId((current) => next.modules.some((module) => module.id === current) ? current : (next.modules[0]?.id || ""));
      })
      .catch((failure) => { if (!controller.signal.aborted) showFailure(failure); })
      .finally(() => { if (!controller.signal.aborted) setLoadingCourse(false); });
    return () => controller.abort();
  }, [connection?.connected, courseId]);

  async function connect() {
    setConnecting(true);
    setError("");
    try {
      const draft: HotmartDraft = { title, description, orientation, courseId, moduleId };
      sessionStorage.setItem(hotmartDraftKey(ownerId, recordingId), JSON.stringify(draft));
      sessionStorage.setItem(hotmartResumeKey(ownerId, recordingId), "1");
      const { url } = await startHotmartConnection(() => tokenGetter.current(), `${location.pathname}${location.search}${location.hash}`);
      location.assign(url);
    } catch (failure) {
      sessionStorage.removeItem(hotmartResumeKey(ownerId, recordingId));
      showFailure(failure);
      setConnecting(false);
    }
  }

  async function disconnect() {
    setMutating(true);
    setError("");
    try {
      await disconnectHotmart(() => tokenGetter.current());
      setConnection((current) => current ? { ...current, connected: false, accountName: undefined } : current);
      setCourses([]);
      setDetail(null);
      setCourseId("");
      setModuleId("");
    } catch (failure) { showFailure(failure); }
    finally { setMutating(false); }
  }

  async function saveCourse() {
    const price = Number(coursePrice.replace(",", "."));
    if (!courseName.trim() || courseDescription.trim().length < 200 || !Number.isFinite(price) || price < 3 || !membershipSlug) return;
    setMutating(true);
    setError("");
    try {
      const course = await createHotmartCourse({
        name: courseName.trim(), description: courseDescription.trim(), price,
        currency: "BRL", locale: "pt_BR", membershipSlug,
      }, () => tokenGetter.current());
      if (!mounted.current) return;
      setCourses((current) => [...current, course]);
      setCourseId(course.id);
      setModuleId("");
      setView("upload");
      setCourseName("");
      setCourseDescription("");
      setCoursePrice("");
    } catch (failure) { if (mounted.current) showFailure(failure); }
    finally { if (mounted.current) setMutating(false); }
  }

  async function saveModule() {
    if (!moduleName.trim() || !courseId) return;
    setMutating(true);
    setError("");
    try {
      const created = await createHotmartModule(courseId, { name: moduleName.trim() }, () => tokenGetter.current());
      if (!mounted.current) return;
      setDetail((current) => current ? { ...current, modules: [...current.modules, created] } : current);
      setModuleId(created.id);
      setModuleName("");
      setView("modules");
    } catch (failure) { if (mounted.current) showFailure(failure); }
    finally { if (mounted.current) setMutating(false); }
  }

  async function saveMembership() {
    if (!membershipName.trim() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(newMembershipSlug) || newMembershipSlug.length < 3) return;
    setMutating(true);
    setError("");
    try {
      const area = await createHotmartMembership({ name: membershipName.trim(), slug: newMembershipSlug }, () => tokenGetter.current());
      if (!mounted.current) return;
      setMemberships((current) => [...current, area]);
      setMembershipSlug(area.slug);
      setMembershipName("");
      setNewMembershipSlug("");
      setView("course");
    } catch (failure) { if (mounted.current) showFailure(failure); }
    finally { if (mounted.current) setMutating(false); }
  }

  async function renameModule() {
    if (!renamingModule || !renamedModule.trim()) return;
    setMutating(true);
    setError("");
    try {
      await renameHotmartModule(courseId, renamingModule, { name: renamedModule.trim() }, () => tokenGetter.current());
      if (!mounted.current) return;
      setDetail((current) => current ? { ...current, modules: current.modules.map((module) => module.id === renamingModule ? { ...module, name: renamedModule.trim() } : module) } : current);
      setRenamingModule(null);
      setView("modules");
    } catch (failure) { if (mounted.current) showFailure(failure); }
    finally { if (mounted.current) setMutating(false); }
  }

  async function moveModule(id: string, direction: -1 | 1) {
    if (!detail || disabled) return;
    const index = detail.modules.findIndex((module) => module.id === id);
    const destination = index + direction;
    if (index < 0 || destination < 0 || destination >= detail.modules.length) return;
    if (detail.modules[index]?.extra || detail.modules[destination]?.extra) return;
    const reordered = [...detail.modules];
    [reordered[index], reordered[destination]] = [reordered[destination], reordered[index]];
    setMutating(true);
    setError("");
    try {
      await reorderHotmartModules(courseId, reordered.filter((module) => !module.extra).map((module) => module.id), () => tokenGetter.current());
      if (mounted.current) setDetail((current) => current ? { ...current, modules: reordered.map((module, order) => ({ ...module, order })) } : current);
    } catch (failure) { if (mounted.current) showFailure(failure); }
    finally { if (mounted.current) setMutating(false); }
  }

  async function sendVideo() {
    if (!connection?.connected || !selectedModule || !title.trim() || disabled || loadingCourse) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    setError("");
    setProgress({ phase: "preparing" });
    let prepared: RecordingFile | undefined;
    let ownsUrl = false;
    try {
      prepared = preparedFiles?.[orientation];
      if (!prepared) {
        let source = file;
        if (source.blob.size === 0) {
          const { materializeRecordingFile } = await import("../recordings/cloudStorage");
          source = await materializeRecordingFile(source, controller.signal, cloudRecordingId ? { id: cloudRecordingId, getToken: () => tokenGetter.current() } : undefined);
          controller.signal.throwIfAborted();
        }
        const { prepareCompatibleDownload } = await import("../media/compatibleExport");
        prepared = await prepareCompatibleDownload(source, (next) => {
          if (mounted.current && !controller.signal.aborted) setProgress({ phase: "preparing", percentage: next.progress === undefined ? undefined : Math.round(next.progress * 100) });
        }, controller.signal);
        ownsUrl = true;
      }
      controller.signal.throwIfAborted();
      const published = await publishHotmartVideo({
        file: prepared, recordingId, courseId, moduleId,
        title: title.trim(), description: description.trim(), publish,
      }, () => tokenGetter.current(), (next) => {
        if (mounted.current && !controller.signal.aborted) setProgress(next);
      }, controller.signal);
      if (!mounted.current) return;
      setSuccess(published);
      sessionStorage.removeItem(hotmartDraftKey(ownerId, recordingId));
    } catch (failure) {
      if (mounted.current) {
        if (controller.signal.aborted) setError("Envio interrompido. O vídeo continua salvo nas suas gravações.");
        else showFailure(failure);
      }
    } finally {
      if (ownsUrl && prepared) URL.revokeObjectURL(prepared.url);
      if (mounted.current) setProgress(null);
      if (activeRequest.current === controller) activeRequest.current = null;
    }
  }

  function openView(next: View) {
    setError("");
    setView(next);
  }

  const close = () => {
    if (busy || mutating || connecting) return;
    onClose();
  };
  const progressLabel = progress?.phase === "preparing" ? "Preparando seu vídeo"
    : progress?.phase === "uploading" ? "Enviando para a Hotmart"
      : progress?.phase === "processing" ? "Processando o vídeo na Hotmart" : "Criando sua aula";

  const canCreateCourse = Boolean(courseName.trim() && courseDescription.trim().length >= 200 && membershipSlug && Number.isFinite(Number(coursePrice.replace(",", "."))) && Number(coursePrice.replace(",", ".")) >= 3);
  const canCreateArea = Boolean(membershipName.trim() && newMembershipSlug.length >= 3 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(newMembershipSlug));
  const heading = success ? "Aula enviada" : loading ? "Enviar para a Hotmart" : !connection?.connected ? "Conectar Hotmart" : {
    upload: "Enviar para a Hotmart", course: "Novo curso", membership: "Nova área de membros",
    modules: "Módulos do curso", "module-create": "Novo módulo", "module-rename": "Renomear módulo",
  }[view];
  const backTo = view === "membership" ? "course" : view === "module-create" || view === "module-rename" ? "modules" : "upload";
  const backLabel = backTo === "course" ? "Voltar ao curso" : backTo === "modules" ? "Voltar aos módulos" : "Voltar ao envio";
  const errorNotice = error && <div className="hotmart-error" role="alert">{error}</div>;

  return (
    <Modal title={heading} onClose={close} className="hotmart-publish-dialog">
      <div className="hotmart-publish" data-testid="hotmart-publish-dialog">
        <div className="hotmart-dialog-body">
          {loading ? (
            <div className="hotmart-loading" role="status"><LoaderCircle className="spin" size={20} /><span>Carregando sua conta…</span></div>
          ) : success ? (
            <div className="hotmart-result" role="status">
              <Check size={24} />
              <h3>{success.published ? "Sua aula está publicada" : "Sua aula foi salva como rascunho"}</h3>
              <p><strong>{title}</strong> foi enviada para {selectedCourse?.name || detail?.course.name}.</p>
              <p>{success.published ? "Os alunos do módulo já podem acessar a aula, de acordo com as regras do curso." : "Você pode revisar e publicar a aula na Hotmart quando estiver pronta."}</p>
            </div>
          ) : !connection?.connected ? (
            <div className="hotmart-connection">
              <p>Entre na sua conta pelo site da Hotmart para escolher um curso e enviar esta gravação.</p>
              <div className="hotmart-recording-context"><FileVideo size={18} /><div><strong>{recordingName}</strong><span>{projectName}</span></div></div>
              {connection?.configured === false && <p className="hotmart-help">A conexão com a Hotmart ainda não está disponível neste ambiente. Você pode continuar baixando seus vídeos.</p>}
              {connection?.configured && connection.message && <p className="hotmart-help">{connection.message}</p>}
              {errorNotice}
              {error && <Button variant="ghost" onClick={() => setReload(value => value + 1)}><RefreshCw size={14} />Tentar novamente</Button>}
            </div>
          ) : (
            <>
              {view === "upload" && progress ? (
                <div className="hotmart-recording-context">
                  <FileVideo size={18} />
                  <div>
                    <strong>{title}</strong>
                    <span>{selectedCourse?.name || detail?.course.name} / {selectedModule?.name}</span>
                  </div>
                </div>
              ) : view === "upload" ? (
                <>
                  <div className="hotmart-account">
                    <span><Check size={14} /><span>{connection.accountName || "Conta Hotmart conectada"}</span></span>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild><IconButton label="Ações da conta Hotmart" disabled={disabled}><MoreHorizontal size={17} /></IconButton></DropdownMenuTrigger>
                      <DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => void disconnect()}><LogOut size={14} />Desconectar Hotmart</DropdownMenuItem></DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <div className="hotmart-recording-context"><FileVideo size={18} /><div><strong>{recordingName}</strong><span>{(file.size / 1024 / 1024).toFixed(1)} MB</span></div></div>
                  <div className="hotmart-format-field">
                    <span className="hotmart-label">Formato do vídeo</span>
                    <ToggleGroup type="single" value={orientation} onValueChange={value => { if (value === "landscape" || value === "portrait") setOrientation(value); }} aria-label="Formato do vídeo para Hotmart" disabled={disabled} className="hotmart-format-toggle">
                      <ToggleGroupItem value="landscape" size="default" aria-label="Horizontal"><Monitor size={15} />Horizontal</ToggleGroupItem>
                      <ToggleGroupItem value="portrait" size="default" aria-label="Vertical"><Smartphone size={15} />Vertical</ToggleGroupItem>
                    </ToggleGroup>
                  </div>
                  <div className="hotmart-destination-fields">
                    <div className="hotmart-field">
                      <div className="hotmart-field-heading"><span className="hotmart-label">Curso</span><Button variant="ghost" size="sm" disabled={disabled} onClick={() => openView("course")}><Plus size={13} />Criar novo curso</Button></div>
                      <Select label="Curso na Hotmart" value={courseId} disabled={disabled || courses.length === 0} placeholder="Escolha um curso" options={courses.map(course => ({ value: course.id, label: course.name }))} onValueChange={value => { setCourseId(value); setModuleId(""); }} />
                    </div>
                    <div className="hotmart-field">
                      <div className="hotmart-field-heading"><span className="hotmart-label">Módulo</span><Button variant="ghost" size="sm" disabled={disabled || !detail || loadingCourse} onClick={() => openView("modules")}>Gerenciar módulos</Button></div>
                      <Select label="Módulo da aula" value={moduleId} disabled={disabled || loadingCourse || !detail?.modules.length} placeholder={loadingCourse ? "Carregando módulos…" : "Escolha um módulo"} options={(detail?.modules || []).map(module => ({ value: module.id, label: module.name }))} onValueChange={setModuleId} />
                    </div>
                  </div>
                  {detail && detail.modules.length === 0 && !loadingCourse && <div className="hotmart-empty-module"><p>Este curso ainda não tem módulos.</p><Button variant="secondary" disabled={disabled} onClick={() => openView("module-create")}><Plus size={14} />Adicionar módulo</Button></div>}
                  <div className="hotmart-fields">
                    <label className="hotmart-field"><span className="hotmart-label">Título da aula</span><Input value={title} maxLength={200} disabled={disabled} onChange={event => setTitle(event.target.value)} required /></label>
                    <label className="hotmart-field"><span className="hotmart-label">Descrição <span className="hotmart-optional">Opcional</span></span><Textarea aria-label="Descrição da aula" value={description} maxLength={10000} rows={4} disabled={disabled} placeholder="O que seus alunos vão aprender?" onChange={event => setDescription(event.target.value)} /></label>
                    <div className="hotmart-field"><span className="hotmart-label">Disponibilidade</span><Select label="Visibilidade da aula" value={publish ? "publish" : "draft"} disabled={disabled} onValueChange={value => setPublish(value === "publish")} options={[{ value: "draft", label: "Salvar como rascunho" }, { value: "publish", label: "Publicar no curso" }]} /><p className="hotmart-help">{publish ? "A aula ficará disponível para os alunos deste módulo." : "Revise a aula na Hotmart antes de publicar."}</p></div>
                  </div>
                </>
              ) : (
                <>
                  <div className="hotmart-subview-nav"><Button variant="ghost" disabled={mutating} onClick={() => openView(backTo)}><ArrowLeft size={15} />{backLabel}</Button></div>
                  {view === "course" && (
                    <form id="hotmart-course-form" className="hotmart-fields" onSubmit={event => { event.preventDefault(); void saveCourse(); }}>
                      <label className="hotmart-field"><span className="hotmart-label">Nome do curso</span><Input autoFocus value={courseName} maxLength={100} onChange={event => setCourseName(event.target.value)} disabled={mutating} required /></label>
                      <label className="hotmart-field"><span className="hotmart-label">Descrição do curso</span><Textarea aria-label="Descrição do curso" value={courseDescription} minLength={200} maxLength={10000} rows={4} onChange={event => setCourseDescription(event.target.value)} disabled={mutating} required /><span className="hotmart-help">{courseDescription.trim().length}/200 caracteres mínimos</span></label>
                      <label className="hotmart-field"><span className="hotmart-label">Preço (R$)</span><Input aria-label="Preço (R$)" value={coursePrice} inputMode="decimal" placeholder="99,00" onChange={event => setCoursePrice(event.target.value)} disabled={mutating} required /><span className="hotmart-help">Mínimo de R$ 3,00.</span></label>
                      <div className="hotmart-field"><div className="hotmart-field-heading"><span className="hotmart-label">Área de membros</span><Button variant="ghost" size="sm" disabled={mutating} onClick={() => openView("membership")}><Plus size={13} />Criar área de membros</Button></div><Select label="Área de membros do novo curso" value={membershipSlug} onValueChange={setMembershipSlug} disabled={mutating || memberships.length === 0} options={memberships.map(area => ({ value: area.slug, label: area.name }))} placeholder="Escolha uma área de membros" /></div>
                      <p className="hotmart-help">O curso será criado em português. Você pode revisar as configurações de venda na Hotmart.</p>
                    </form>
                  )}
                  {view === "membership" && (
                    <form id="hotmart-membership-form" className="hotmart-fields" onSubmit={event => { event.preventDefault(); void saveMembership(); }}>
                      <p className="hotmart-help">A área de membros reúne seus cursos em um só lugar.</p>
                      <label className="hotmart-field"><span className="hotmart-label">Nome da área de membros</span><Input autoFocus maxLength={100} value={membershipName} onChange={event => setMembershipName(event.target.value)} disabled={mutating} required /></label>
                      <label className="hotmart-field"><span className="hotmart-label">Identificador da área</span><Input aria-label="Identificador da área" value={newMembershipSlug} minLength={3} maxLength={60} placeholder="minha-escola" onChange={event => setNewMembershipSlug(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} disabled={mutating} required /><span className="hotmart-help">Use letras minúsculas, números e hífens.</span></label>
                    </form>
                  )}
                  {view === "modules" && (
                    <div className="hotmart-module-management">
                      <div className="hotmart-management-heading"><span>{selectedCourse?.name || detail?.course.name}</span><Button variant="secondary" disabled={mutating || !detail} onClick={() => openView("module-create")}><Plus size={14} />Adicionar módulo</Button></div>
                      {loadingCourse ? <div className="hotmart-loading" role="status"><LoaderCircle className="spin" size={18} />Carregando módulos…</div> : !detail?.modules.length ? <div className="hotmart-empty-module"><BookOpen size={20} /><p>Adicione o primeiro módulo do seu curso.</p></div> : (
                        <div className="hotmart-modules" aria-label="Estrutura do curso">
                          {detail.modules.map((module, index) => (
                            <div key={module.id} className={`hotmart-module${module.id === moduleId ? " is-selected" : ""}`}>
                              <div className="hotmart-module-row">
                                <Button variant="ghost" className="hotmart-module-select" aria-label={`Selecionar módulo ${module.name}`} aria-pressed={module.id === moduleId} disabled={mutating} onClick={() => setModuleId(module.id)}><BookOpen size={15} /><span>{module.name}</span>{module.id === moduleId && <Check size={14} />}</Button>
                                <span className="hotmart-module-count">{module.lessons.length} {module.lessons.length === 1 ? "aula" : "aulas"}</span>
                                {module.lessons.length > 0 && <IconButton label={`Ver aulas de ${module.name}`} aria-expanded={expandedModules.has(module.id)} disabled={mutating} onClick={() => setExpandedModules(current => { const next = new Set(current); if (next.has(module.id)) next.delete(module.id); else next.add(module.id); return next; })}>{expandedModules.has(module.id) ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</IconButton>}
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild><IconButton label={`Ações do módulo ${module.name}`} disabled={mutating}><MoreHorizontal size={16} /></IconButton></DropdownMenuTrigger>
                                  <DropdownMenuContent align="end">
                                    <DropdownMenuItem onSelect={() => { setRenamingModule(module.id); setRenamedModule(module.name); openView("module-rename"); }}><Pencil size={14} />Renomear módulo</DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem disabled={index === 0 || module.extra || detail.modules[index - 1]?.extra} onSelect={() => void moveModule(module.id, -1)}><ArrowUp size={14} />Mover para cima</DropdownMenuItem>
                                    <DropdownMenuItem disabled={index === detail.modules.length - 1 || module.extra || detail.modules[index + 1]?.extra} onSelect={() => void moveModule(module.id, 1)}><ArrowDown size={14} />Mover para baixo</DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </div>
                              {expandedModules.has(module.id) && <ul className="hotmart-lessons">{module.lessons.map(lesson => <li key={lesson.id}><FileVideo size={13} /><span>{lesson.title}</span>{!lesson.published && <span className="hotmart-help">Rascunho</span>}</li>)}</ul>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {view === "module-create" && <form id="hotmart-module-form" className="hotmart-fields" onSubmit={event => { event.preventDefault(); void saveModule(); }}><p className="hotmart-help">O módulo será adicionado a {selectedCourse?.name || detail?.course.name}.</p><label className="hotmart-field"><span className="hotmart-label">Nome do módulo</span><Input autoFocus value={moduleName} maxLength={200} onChange={event => setModuleName(event.target.value)} disabled={mutating} required /></label></form>}
                  {view === "module-rename" && <form id="hotmart-rename-form" className="hotmart-fields" onSubmit={event => { event.preventDefault(); void renameModule(); }}><label className="hotmart-field"><span className="hotmart-label">Novo nome do módulo</span><Input autoFocus aria-label="Novo nome do módulo" value={renamedModule} maxLength={200} onChange={event => setRenamedModule(event.target.value)} disabled={mutating} required /></label></form>}
                </>
              )}
              {errorNotice}
              {progress && <div className="hotmart-progress" role="status"><div><LoaderCircle className="spin" size={16} /><span>{progressLabel}</span>{progress.phase === "uploading" && progress.percentage !== undefined && <span className="hotmart-progress-value">{Math.round(progress.percentage)}%</span>}</div><progress aria-label={progressLabel} max={100} value={progress.percentage === undefined ? undefined : Math.max(0, Math.min(100, progress.percentage))} /><p className="hotmart-help">Mantenha esta janela aberta até concluir.</p></div>}
            </>
          )}
        </div>
        {!loading && <footer className="hotmart-publish-footer">
          {success ? <><Button variant="ghost" onClick={onClose}>Voltar à gravação</Button>{success.url && <Button asChild><a href={success.url} target="_blank" rel="noopener noreferrer">Abrir na Hotmart<ExternalLink size={14} /></a></Button>}</> : !connection?.connected ? <><Button variant="ghost" disabled={connecting} onClick={onClose}>Cancelar</Button><Button disabled={!connection?.configured || connecting} onClick={() => void connect()}>{connecting && <LoaderCircle className="spin" size={15} />}{connecting ? "Abrindo a Hotmart…" : "Conectar minha conta Hotmart"}</Button></> : view === "upload" ? <>{busy ? <Button variant="ghost" disabled={progress?.phase === "creating"} onClick={() => activeRequest.current?.abort()}>Interromper envio</Button> : <Button variant="ghost" disabled={mutating || connecting} onClick={onClose}>Cancelar</Button>}<Button disabled={disabled || !selectedModule || !title.trim() || loadingCourse} onClick={() => void sendVideo()}>{busy ? <LoaderCircle className="spin" size={15} /> : <Upload size={15} />}{publish ? "Enviar e publicar aula" : "Enviar como rascunho"}</Button></> : view === "course" ? <><Button variant="ghost" disabled={mutating} onClick={() => openView("upload")}>Cancelar</Button><Button type="submit" form="hotmart-course-form" disabled={mutating || !canCreateCourse}>{mutating && <LoaderCircle className="spin" size={15} />}Criar curso</Button></> : view === "membership" ? <><Button variant="ghost" disabled={mutating} onClick={() => openView("course")}>Cancelar</Button><Button type="submit" form="hotmart-membership-form" disabled={mutating || !canCreateArea}>{mutating && <LoaderCircle className="spin" size={15} />}Criar e selecionar área</Button></> : view === "modules" ? <Button disabled={!selectedModule || mutating} onClick={() => openView("upload")}>Usar módulo</Button> : view === "module-create" ? <><Button variant="ghost" disabled={mutating} onClick={() => openView("modules")}>Cancelar</Button><Button type="submit" form="hotmart-module-form" disabled={mutating || !moduleName.trim()}>{mutating && <LoaderCircle className="spin" size={15} />}Criar módulo</Button></> : <><Button variant="ghost" disabled={mutating} onClick={() => openView("modules")}>Cancelar</Button><Button type="submit" form="hotmart-rename-form" disabled={mutating || !renamedModule.trim()}>{mutating && <LoaderCircle className="spin" size={15} />}Salvar nome</Button></>}
        </footer>}
      </div>
    </Modal>
  );
}
