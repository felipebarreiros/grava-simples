import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Clapperboard, Folder, LayoutGrid, Link, Pencil, Video, X } from "lucide-react";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { TabsList, TabsTrigger } from "./ui/tabs";
import { Tooltip } from "./ui/tooltip";
import "./ProjectBreadcrumbs.css";

interface ProjectBreadcrumbsProps {
  projectId: string;
  projectName: string;
  recordingsCount: number;
  busy: boolean;
  onAllProjects: () => void;
  onEdit: () => void;
  onRecordings?: () => void;
}

export function ProjectBreadcrumbs({
  projectId,
  projectName,
  recordingsCount,
  busy,
  onAllProjects,
  onEdit,
  onRecordings,
}: ProjectBreadcrumbsProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  const editAfterClose = useRef(false);
  const [feedback, setFeedback] = useState<"copied" | "failed" | null>(null);

  useEffect(() => {
    if (!feedback) return;
    const timeout = window.setTimeout(() => setFeedback(null), feedback === "copied" ? 4000 : 8000);
    return () => window.clearTimeout(timeout);
  }, [feedback]);

  async function copyProjectLink() {
    const url = new URL(window.location.pathname, window.location.origin);
    url.hash = `project/${projectId}`;
    setFeedback(null);
    try {
      await navigator.clipboard.writeText(url.href);
      setFeedback("copied");
    } catch {
      setFeedback("failed");
    }
  }

  return (
    <nav className="workspace-title project-breadcrumbs" aria-label="Navegação do projeto">
      <ol className="breadcrumb-trail">
        <li className="breadcrumb-root">
          <Tooltip content="Todos os projetos">
            <Button
              variant="ghost"
              size="icon"
              className="breadcrumb-home"
              aria-label="Todos os projetos"
              disabled={busy}
              onClick={onAllProjects}
            >
              <LayoutGrid size={15} aria-hidden="true" />
            </Button>
          </Tooltip>
        </li>
        <li className="breadcrumb-project">
          <span className="breadcrumb-separator breadcrumb-root-separator" aria-hidden="true">/</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                ref={trigger}
                variant="ghost"
                className="project-title-button"
                title={projectName}
              >
                <Folder size={15} className="breadcrumb-project-icon" aria-hidden="true" />
                <span className="project-title-name">{projectName}</span>
                <ChevronDown size={12} className="breadcrumb-project-chevron" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="project-breadcrumb-menu"
              aria-label={`Ações do projeto ${projectName}`}
              aria-labelledby={undefined}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                trigger.current?.focus({ preventScroll: true });
                if (editAfterClose.current) {
                  editAfterClose.current = false;
                  onEdit();
                }
              }}
            >
              <DropdownMenuItem onSelect={() => void copyProjectLink()}>
                <Link aria-hidden="true" />
                Copiar link do projeto
              </DropdownMenuItem>
              <DropdownMenuItem disabled={busy} onSelect={() => { editAfterClose.current = true; }}>
                <Pencil aria-hidden="true" />
                Renomear projeto
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </li>
        <li className="breadcrumb-sections">
          <span className="breadcrumb-separator" aria-hidden="true">/</span>
          <TabsList className="project-tabs" aria-label="Área do projeto">
            <TabsTrigger value="studio">
              <Video size={15} aria-hidden="true" />
              Estúdio
            </TabsTrigger>
            <TabsTrigger value="recordings" disabled={busy} onClick={onRecordings}>
              <Clapperboard size={15} aria-hidden="true" />
              Gravações
              {recordingsCount > 0 && <span className="ui-tabs-count">{recordingsCount}</span>}
            </TabsTrigger>
          </TabsList>
        </li>
      </ol>
      <div className={`breadcrumb-feedback ${!feedback ? "is-idle" : feedback === "failed" ? "is-error" : ""}`}>
        {feedback === "copied" && <Check size={14} aria-hidden="true" />}
        {feedback === "failed" && <X size={14} aria-hidden="true" />}
        <span role={feedback === "failed" ? "alert" : "status"}>
          {feedback === "copied" ? "Link copiado" : feedback === "failed" ? "Não foi possível copiar o link. Tente novamente." : ""}
        </span>
      </div>
    </nav>
  );
}
