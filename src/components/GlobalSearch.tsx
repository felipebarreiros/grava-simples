import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowDown, ArrowUp, Clapperboard, CornerDownLeft, FileVideo, Folder, Search, X } from "lucide-react";
import type { Project, ProjectScene, ProjectTake } from "../projects/store";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Dialog, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogTitle } from "./ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import "./GlobalSearch.css";

export type SearchResult =
  | { type: "project"; project: Project }
  | { type: "recording"; project: Project; take: ProjectTake }
  | { type: "scene"; project: Project; scene: ProjectScene };

type Category = "all" | SearchResult["type"];
const categories: { value: Category; label: string }[] = [
  { value: "all", label: "Todos" },
  { value: "project", label: "Projetos" },
  { value: "recording", label: "Gravações" },
  { value: "scene", label: "Cenas" },
];
const groups = [
  { type: "project", label: "Projetos" },
  { type: "recording", label: "Gravações" },
  { type: "scene", label: "Cenas" },
] as const;
const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR");
const resultKey = (result: SearchResult) => `${result.type}-${result.project.id}-${result.type === "recording" ? result.take.id : result.type === "scene" ? result.scene.id : ""}`;
const resultName = (result: SearchResult) => result.type === "recording" ? result.take.name : result.type === "scene" ? result.scene.name : result.project.name;
const duration = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
const updated = (stamp: number) => new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "short" }).format(stamp);

export function GlobalSearch({
  projects,
  takes,
  onClose,
  onSelect,
  navigationDisabled = false,
}: {
  projects: Project[];
  takes: ProjectTake[];
  onClose: () => void;
  onSelect: (result: SearchResult) => void;
  navigationDisabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<Category>("all");
  const [activeIndex, setActiveIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const previousFocus = useRef(document.activeElement as HTMLElement | null);
  const id = useId();
  const tokens = normalize(query.trim()).split(/\s+/).filter(Boolean);
  const matches = (value: string) => tokens.every((token) => normalize(value).includes(token));
  const results = useMemo(() => {
    const orderedProjects = [...projects].sort((a, b) => b.updatedAt - a.updatedAt);
    const byId = new Map(projects.map((project) => [project.id, project]));
    const all: SearchResult[] = [
      ...orderedProjects.map((project): SearchResult => ({ type: "project", project })),
      ...[...takes].sort((a, b) => b.createdAt - a.createdAt).flatMap((take): SearchResult[] => {
        const project = byId.get(take.projectId);
        return project ? [{ type: "recording", project, take }] : [];
      }),
      ...orderedProjects.flatMap((project) => project.scenes.map((scene): SearchResult => ({ type: "scene", project, scene }))),
    ];
    return all.filter((result) => matches(`${resultName(result)} ${result.type === "project" ? "" : result.project.name}`));
  }, [projects, takes, query]);
  const visibleGroups = groups.map((group) => {
    const matching = category === "all" || category === group.type ? results.filter((result) => result.type === group.type) : [];
    return { ...group, results: query.trim() || category !== "all" ? matching : matching.slice(0, 3) };
  }).filter((group) => group.results.length > 0);
  const visibleResults = visibleGroups.flatMap((group) => group.results);
  const selectedIndex = Math.min(activeIndex, visibleResults.length - 1);
  const selected = visibleResults[selectedIndex];
  const activeId = selected ? `${id}-option-${resultKey(selected)}` : undefined;

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  function choose(result: SearchResult) {
    if (!navigationDisabled) onSelect(result);
  }

  function navigateResults(event: KeyboardEvent<HTMLInputElement>) {
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && visibleResults.length) {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((selectedIndex + direction + visibleResults.length) % visibleResults.length);
    } else if (event.key === "Enter" && selected && !event.nativeEvent.isComposing) {
      event.preventDefault();
      choose(selected);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPortal>
        <DialogOverlay className="global-search-backdrop" />
        <DialogContent
      className="global-search"
      aria-describedby={`${id}-description`}
      onOpenAutoFocus={(event) => { event.preventDefault(); input.current?.focus(); }}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        if (!document.querySelector('[role="dialog"], [role="alertdialog"]') && previousFocus.current?.isConnected)
          previousFocus.current.focus({ preventScroll: true });
      }}
    >
      <DialogTitle className="global-search-title">Busca global</DialogTitle>
      <div className="global-search-input-row">
        <Search size={23} strokeWidth={1.7} aria-hidden="true" />
        <Input
          ref={input}
          autoFocus
          role="combobox"
          aria-label="Buscar projetos, gravações e cenas"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls={`${id}-results`}
          aria-activedescendant={activeId}
          placeholder="Buscar no seu espaço…"
          value={query}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
          onKeyDown={navigateResults}
        />
        {query && <Button variant="ghost" className="global-search-clear" aria-label="Limpar busca" onClick={() => { setQuery(""); setActiveIndex(0); input.current?.focus(); }}><X size={15} /></Button>}
        <Button variant="ghost" className="global-search-close" aria-label="Fechar busca" onClick={onClose}><kbd>esc</kbd></Button>
      </div>
      <Tabs value={category} onValueChange={(value) => { setCategory(value as Category); setActiveIndex(0); }} className="global-search-tabs">
      <TabsList className="global-search-filters" aria-label="Tipos de resultado">
        {categories.map((item) => <TabsTrigger
          key={item.value}
          value={item.value}
          onClick={(event) => { if (event.detail > 0) input.current?.focus(); }}
        >{item.label}{query.trim() && <span>{item.value === "all" ? results.length : results.filter((result) => result.type === item.value).length}</span>}</TabsTrigger>)}
      </TabsList>
      <TabsContent value={category} className="global-search-panel" tabIndex={-1}>
      <DialogDescription className="global-search-description" id={`${id}-description`}>
        {query.trim() ? `${visibleResults.length} ${visibleResults.length === 1 ? "resultado encontrado" : "resultados encontrados"}` : "Seu próximo passo está aqui"}
      </DialogDescription>
      <div className="global-search-results" id={`${id}-results`} role="listbox" aria-label="Resultados da busca" aria-busy="false">
        {visibleGroups.map((group) => <div key={group.type} role="group" aria-labelledby={`${id}-${group.type}-label`} className="global-search-group">
          <div id={`${id}-${group.type}-label`} className="global-search-group-heading"><span>{group.label}</span>{!query.trim() && category === "all" && <span>Recentes</span>}</div>
          {group.results.map((result) => {
            const key = resultKey(result);
            const active = result === selected;
            const Icon = result.type === "project" ? Folder : result.type === "recording" ? FileVideo : Clapperboard;
            const secondary = result.type === "project" ? `${result.project.scenes.length} cenas · Atualizado em ${updated(result.project.updatedAt)}` : result.type === "recording" ? `${result.project.name} · ${duration(result.take.durationMs)}` : result.project.name;
            return <Button
              key={key}
              id={`${id}-option-${key}`}
              variant="ghost"
              role="option"
              aria-selected={active}
              aria-disabled={navigationDisabled}
              tabIndex={-1}
              className={`global-search-result ${active ? "active" : ""}`}
              onMouseMove={() => setActiveIndex(visibleResults.indexOf(result))}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(result)}
            >
              <span className={`global-search-result-icon ${result.type}`}><Icon size={19} strokeWidth={1.7} /></span>
              <span className="global-search-result-text"><strong>{resultName(result)}</strong><span>{secondary}</span></span>
              <CornerDownLeft className="global-search-result-enter" size={15} aria-hidden="true" />
            </Button>;
          })}
        </div>)}
      </div>
      {!visibleResults.length && <div className="global-search-empty" role="status"><span><Search size={25} strokeWidth={1.5} /></span><strong>{query.trim() ? "Nenhum resultado por aqui" : "Tudo pronto para começar"}</strong><p>{query.trim() ? "Tente outro nome ou busque em uma categoria diferente." : "Seus projetos, gravações e cenas vão aparecer aqui."}</p></div>}
      </TabsContent>
      </Tabs>
      <footer className="global-search-footer">
        <span className="global-search-scope">{navigationDisabled ? "Aguarde para abrir um resultado" : "Todo o seu espaço"}</span>
        <div><span><kbd><ArrowUp size={11} /></kbd><kbd><ArrowDown size={11} /></kbd> navegar</span><span><kbd><CornerDownLeft size={11} /></kbd> abrir</span></div>
      </footer>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
