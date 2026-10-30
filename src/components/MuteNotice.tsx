import { Mic, MicOff, X, AudioLines } from "lucide-react";
import { Button } from "./ui/button";
import { IconButton } from "./StudioUi";

export function MuteNotice({
  onUnmute,
  onDismiss,
}: {
  onUnmute: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="mute-notice" role="alert" data-testid="muted-speech-alert">
      <span className="mute-notice-icon">
        <MicOff size={20} />
        <AudioLines size={11} />
      </span>
      <div>
        <strong>Sua voz quer entrar!</strong>
        <p>Parece que você está falando com o microfone no mudo.</p>
        <div>
          <Button size="sm" onClick={onUnmute}>
            <Mic size={13} />
            Ativar microfone
          </Button>
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Agora não
          </Button>
        </div>
      </div>
      <IconButton label="Fechar aviso de microfone" onClick={onDismiss}>
        <X size={15} />
      </IconButton>
    </div>
  );
}
