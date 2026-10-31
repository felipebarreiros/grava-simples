import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Download, Eye, EyeOff, LoaderCircle, RotateCcw, Smartphone, Unplug, Wifi } from 'lucide-react';
import { RemoteController, type RemoteControlState } from '../remote/controller';
import type { RemoteCommand, RemoteCommandResult, RemoteSnapshot } from '../remote/types';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Modal } from './StudioUi';
import './RemoteControl.css';

export interface RemoteControlProps {
  projectId: string;
  ownerId?: string | null;
  getSnapshot: () => RemoteSnapshot;
  execute: (command: RemoteCommand) => Promise<RemoteCommandResult>;
}
const statusText = (state: RemoteControlState): string => {
  switch (state.status) {
    case 'connecting': return 'Conectando ao computador…';
    case 'waiting': return 'Pronto para conectar o OBS Blade';
    case 'connected': return 'Celular conectado pela rede local';
    case 'reconnecting': return 'Reconectando ao computador…';
    case 'permission-required': return 'Permita a conexão com este computador';
    case 'permission-denied': return 'Acesso à rede local bloqueado';
    case 'helper-missing': return 'Aplicativo de conexão não encontrado';
    case 'in-use': return 'Outra aba do estúdio está conectada';
    case 'error': return 'Não foi possível conectar';
    default: return 'Controle desativado neste projeto';
  }
};

export function RemoteControl(props: RemoteControlProps) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<RemoteControlState>({ status: 'idle' });
  const [selectedAddress, setSelectedAddress] = useState('');
  const [revealPassword, setRevealPassword] = useState(false);
  const [copied, setCopied] = useState('');
  const [copyError, setCopyError] = useState('');
  const current = useRef(props); current.current = props;
  const controller = useRef<RemoteController | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!props.ownerId) return;
    const connection = new RemoteController({
      projectId: props.projectId, ownerId: props.ownerId,
      getSnapshot: () => current.current.getSnapshot(),
      execute: command => current.current.execute(command),
      onChange: setState,
    });
    controller.current = connection;
    setState(connection.getState());
    setRevealPassword(false); setCopied(''); setCopyError('');
    void connection.start();
    return () => {
      connection.dispose(); clearTimeout(copyTimer.current);
      if (controller.current === connection) controller.current = null;
    };
  }, [props.projectId, props.ownerId]);

  useEffect(() => {
    const addresses = state.pairing?.addresses ?? [];
    setSelectedAddress(previous => addresses.includes(previous) ? previous : addresses[0] ?? '');
  }, [state.pairing?.connectionId, state.pairing?.addresses.join(',')]);

  async function copy(name: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(name); setCopyError(''); clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(''), 2000);
    } catch { setCopyError('Selecione o campo e copie o valor manualmente.'); }
  }
  const active = Boolean(state.pairing);
  const busy = state.status === 'connecting' || state.status === 'reconnecting';

  return <>
    <Button variant="outline" size="sm" className={`remote-control-trigger ${active ? 'is-active' : ''}`}
      onClick={() => setOpen(true)} aria-label="Controle pelo celular" title="Controle pelo celular">
      <Smartphone size={16} /><span>Celular</span>
      {active && <i className={`remote-trigger-indicator ${state.status === 'connected' ? 'is-connected' : ''}`} aria-hidden="true" />}
    </Button>
    {open && <Modal title="Controle pelo celular"
      description="Controle este projeto com o OBS Blade no mesmo Wi-Fi do computador."
      onClose={() => setOpen(false)} className="remote-control-modal">
      <div className="remote-control-content ph-no-capture rr-block" data-ph-no-capture="true">
        <div className={`remote-connection-status ${state.status}`} role="status" aria-live="polite">
          {busy ? <LoaderCircle size={18} className="remote-spinner" /> : <Wifi size={18} />}
          <strong>{statusText(state)}</strong>
        </div>
        {state.error && <p className="remote-control-error" role="alert">{state.error}</p>}

        {state.pairing ? <>
          <ol className="remote-setup-steps">
            <li>Conecte o celular e o computador ao mesmo Wi-Fi.</li>
            <li>No OBS Blade, adicione uma conexão manual e escolha <strong>IP</strong>.</li>
            <li>Use os dados abaixo. Se houver uma opção de conexão segura, deixe-a desativada para esta rede local.</li>
          </ol>
          <div className="remote-connection-fields">
            <label className="remote-connection-field"><span>IP do computador</span>
              <div><Input aria-label="IP do computador" value={selectedAddress} readOnly autoComplete="off" spellCheck={false} onFocus={event => event.target.select()} />
                <Button variant="ghost" size="icon" aria-label="Copiar IP" disabled={!selectedAddress} onClick={() => void copy('ip', selectedAddress)}>{copied === 'ip' ? <Check size={16} /> : <Copy size={16} />}</Button></div>
            </label>
            {!selectedAddress && <p className="remote-control-note">Nenhum IP da rede local foi encontrado. Conecte o computador ao Wi-Fi e reconecte o aplicativo.</p>}
            {state.pairing.addresses.length > 1 && <div className="remote-other-addresses"><span>Se necessário, tente outro IP:</span>{state.pairing.addresses.filter(address => address !== selectedAddress).map(address => <Button key={address} variant="ghost" size="sm" onClick={() => setSelectedAddress(address)}>{address}</Button>)}</div>}
            <label className="remote-connection-field"><span>Porta</span><Input aria-label="Porta do OBS Blade" value={String(state.pairing.port)} readOnly /></label>
            <label className="remote-connection-field"><span>Senha</span>
              <div><Input aria-label="Senha do OBS Blade" type={revealPassword ? 'text' : 'password'} value={state.pairing.password} readOnly autoComplete="off" onFocus={event => event.target.select()} />
                <Button variant="ghost" size="icon" aria-label={revealPassword ? 'Ocultar senha' : 'Mostrar senha'} onClick={() => setRevealPassword(value => !value)}>{revealPassword ? <EyeOff size={16} /> : <Eye size={16} />}</Button>
                <Button variant="ghost" size="icon" aria-label="Copiar senha" onClick={() => void copy('password', state.pairing!.password)}>{copied === 'password' ? <Check size={16} /> : <Copy size={16} />}</Button></div>
            </label>
          </div>
          {copyError && <p className="remote-control-note" role="status">{copyError}</p>}
          <p className="remote-control-note">Configure o OBS Blade uma vez. A senha fica salva apenas no aplicativo do computador, que reconecta quando você abre o estúdio. Compartilhe-a somente com quem pode operar este projeto.</p>
          <div className="remote-connection-actions">
            <Button variant="outline" onClick={() => { setRevealPassword(false); controller.current?.stop(); }}><Unplug size={16} />Desconectar deste projeto</Button>
            <Button variant="ghost" size="sm" onClick={() => { setRevealPassword(false); controller.current?.resetPairing(); }}><RotateCcw size={14} />Redefinir pareamento</Button>
          </div>
          <p className="remote-control-note">Redefinir o pareamento gera outra senha e desconecta os celulares anteriores.</p>
        </> : <>
          {(state.status === 'permission-required' || state.status === 'permission-denied') && <p className="remote-control-note">{state.status === 'permission-denied'
            ? 'Nas permissões deste site, permita o acesso à rede local e tente novamente. Essa permissão conecta o site ao aplicativo deste computador.'
            : 'Clique em conectar e permita o acesso à rede local quando o navegador pedir. Essa autorização é necessária apenas na primeira configuração.'}</p>}
          <p className="remote-control-intro">Troque cenas, mostre ou oculte fontes, silencie o microfone e inicie ou pare os dois vídeos pelo celular.</p>
          <section className="remote-install" aria-label="Instalar aplicativo de conexão">
            <strong>Instale uma vez neste computador</strong>
            <p>Baixe o aplicativo para seu sistema, extraia o ZIP e execute o instalador. Ele inicia automaticamente com o computador.</p>
            <div className="remote-downloads">
              <Button asChild variant="outline" size="sm"><a href="/companion/gravasimples-macos.zip" download><Download size={14} />Baixar para Mac</a></Button>
              <Button asChild variant="outline" size="sm"><a href="/companion/gravasimples-windows.zip" download><Download size={14} />Baixar para Windows</a></Button>
            </div>
          </section>
          <Button onClick={() => void controller.current?.start(true)} disabled={busy || !props.ownerId}>
            {busy ? <LoaderCircle size={16} className="remote-spinner" /> : <Smartphone size={16} />}
            {busy ? 'Conectando…' : 'Conectar ao computador'}
          </Button>
          <p className="remote-control-note">Prepare câmeras e telas no computador e mantenha este projeto aberto. O celular controla apenas este estúdio pela rede local.</p>
        </>}
        <p className="remote-control-boundary">Fechar esta janela mantém o controle ativo. Se a conexão cair, a gravação continua no computador. Preview remoto, pausa de gravação e marcadores pelo celular ainda não estão disponíveis.</p>
      </div>
    </Modal>}
  </>;
}
