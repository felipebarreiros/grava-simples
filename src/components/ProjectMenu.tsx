import { useRef, type ReactNode } from "react";
import { FolderOpen, Pencil, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./ui/context-menu";

interface ProjectMenuProps {
  name: string;
  children: ReactNode;
  disabled?: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function ProjectMenu({ context = false, name, children, disabled, onOpen, onEdit, onDelete }: ProjectMenuProps & { context?: boolean }) {
  const trigger = useRef<HTMLElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const pendingAction = useRef<(() => void) | null>(null);
  const Root = context ? ContextMenu : DropdownMenu;
  const Trigger = context ? ContextMenuTrigger : DropdownMenuTrigger;
  const Content = context ? ContextMenuContent : DropdownMenuContent;
  const Item = context ? ContextMenuItem : DropdownMenuItem;
  const Label = context ? ContextMenuLabel : DropdownMenuLabel;
  const Separator = context ? ContextMenuSeparator : DropdownMenuSeparator;
  return (
    <Root onOpenChange={(open) => {
      if (open) previousFocus.current = context
        ? document.activeElement as HTMLElement | null
        : trigger.current;
    }}>
      <Trigger
        asChild
        ref={(element: HTMLElement | null) => { trigger.current = element; }}
        disabled={disabled}
        onContextMenu={context ? (event) => {
          const target = (event.target as HTMLElement).closest<HTMLButtonElement>("button") ?? event.currentTarget.querySelector<HTMLButtonElement>("button");
          target?.focus({ preventScroll: true });
        } : undefined}
      >{children}</Trigger>
      <Content
        {...(!context ? { align: "end" as const } : {})}
        aria-label={`Ações do projeto ${name}`}
        aria-labelledby={undefined}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true });
          const action = pendingAction.current;
          pendingAction.current = null;
          action?.();
        }}
      >
        <Label>{name}</Label>
        <Item disabled={disabled} onSelect={() => { pendingAction.current = onOpen; }}><FolderOpen />Abrir estúdio</Item>
        <Item disabled={disabled} onSelect={() => { pendingAction.current = onEdit; }}><Pencil />Renomear projeto</Item>
        <Separator />
        <Item disabled={disabled} destructive onSelect={() => { pendingAction.current = onDelete; }}><Trash2 />Excluir projeto</Item>
      </Content>
    </Root>
  );
}

export function ProjectDropdownMenu(props: ProjectMenuProps) {
  return <ProjectMenu {...props} />;
}

export function ProjectContextMenu(props: ProjectMenuProps) {
  return <ProjectMenu {...props} context />;
}
