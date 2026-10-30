import { Camera, ChevronRight, FileImage, Monitor } from "lucide-react";
import type { ProjectSource } from "../projects/sources";
import { Button } from "./ui/button";
import "./SourceLibrary.css";

export function SourceLibrary({ sources, selectedId, isConnected, onUse, disabled }: {
  sources: ProjectSource[];
  selectedId?: string;
  isConnected: (id: string) => boolean;
  onUse: (source: ProjectSource) => void;
  disabled: boolean;
}) {
  if (!sources.length) return null;
  return (
    <section className="source-library" aria-label="Fontes do projeto">
      <h3>Fontes do projeto</h3>
      <p>Use a mesma fonte em várias cenas.</p>
      <div className="source-library-list">
        {sources.map(source => {
          const connected = isConnected(source.id);
          const Icon = source.kind === "camera" ? Camera : source.kind === "screen" ? Monitor : FileImage;
          return (
            <Button key={source.id} variant="ghost" className="source-library-item"
              data-testid={`source-use-${source.id}`} disabled={disabled}
              onClick={() => onUse(source)}>
              <Icon size={20} />
              <span>
                <strong>{source.name}</strong>
                <small>{connected
                  ? source.id === selectedId ? "Em uso nesta camada" : "Usar fonte conectada"
                  : source.kind === "screen" ? "Compartilhar novamente"
                    : source.kind === "camera" ? "Conectar câmera" : "Usar arquivo salvo"}</small>
              </span>
              <ChevronRight size={16} />
            </Button>
          );
        })}
      </div>
    </section>
  );
}
