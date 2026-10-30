import { useEffect, useRef, useState } from "react";
import {
  ArrowDown, ArrowRight, Camera, Check, Download, Flame,
  FolderOpen, Layers, LockKeyhole, Mic, Monitor, MousePointer2, Pause,
  Play, Plus, Settings2, Smartphone, Video,
} from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "../components/ui/button";
import "./auth.css";
import "./landing.css";

export function Brand() {
  return (
    <Link className="auth-brand" to="/" aria-label="GravaSimples — início">
      <Flame size={27} aria-hidden="true" />
      <span>Grava<span className="auth-brand-light">Simples</span></span>
    </Link>
  );
}

type DemoScene = "camera" | "presentation" | "countdown";
const scenes: { id: DemoScene; label: string; icon: typeof Camera }[] = [
  { id: "camera", label: "Câmera", icon: Camera },
  { id: "presentation", label: "Câmera + tela", icon: Monitor },
  { id: "countdown", label: "Contagem", icon: Layers },
];

function Slide({ small = false }: { small?: boolean }) {
  return (
    <div className={`lp-slide ${small ? "is-small" : ""}`}>
      <span className="lp-slide-kicker"><span /> IDEIAS QUE MOVEM</span>
      <strong>O que você<br />quer ensinar<br /><em>ao mundo?</em></strong>
      <div className="lp-slide-orbit" />
      <span className="lp-slide-foot">SUA PRÓXIMA GRANDE IDEIA <span>01 / 06</span></span>
    </div>
  );
}

function DemoFrame({ scene, portrait = false }: { scene: DemoScene; portrait?: boolean }) {
  return (
    <div className={`lp-demo-frame ${portrait ? "is-portrait" : "is-landscape"} scene-${scene}`}>
      {scene === "countdown" ? <>
        <img className="lp-countdown-image" src="/scenes/countdown-studio.webp" alt="" width="960" height="540" />
        <div className="lp-countdown-content"><span>BOAS IDEIAS MERECEM UM COMEÇO</span><strong>Já vamos<br />começar.</strong><b>05:00</b></div>
      </> : <>
        {scene === "presentation" && <Slide small={portrait} />}
        <div className="lp-camera-content"><img src="/scenes/mascot-concept.webp" alt="" width="960" height="540" /><span className="lp-camera-caption">Olá, boas ideias.</span></div>
      </>}
      <span className="lp-demo-rec"><i /> REC <span>00:24</span></span>
      <span className="lp-demo-frame-format">{portrait ? "9:16" : "16:9"}</span>
    </div>
  );
}

function StudioDemo() {
  const [scene, setScene] = useState<DemoScene>("presentation");
  const [paused, setPaused] = useState(false);
  return (
    <div className={`lp-product-demo ${paused ? "is-paused" : ""}`}>
      <div className="lp-demo-context"><span><span className="lp-live-dot" /> UMA PRÉVIA DO SEU ESPAÇO</span><span>Explore as cenas abaixo <ArrowDown size={12} /></span></div>
      <div className="lp-demo-window">
        <div className="lp-demo-titlebar" aria-hidden="true">
          <div className="lp-window-dots"><i /><i /><i /></div>
          <span><Video size={13} /> Minha próxima boa ideia</span>
          <span className="lp-demo-save"><Check size={12} /> Salvo neste navegador</span>
        </div>
        <div className="lp-demo-body">
          <div className="lp-demo-rail" aria-hidden="true"><Flame size={22} /><span className="is-active"><Video size={17} /></span><span><FolderOpen size={17} /></span><span><Layers size={17} /></span><span className="lp-rail-bottom"><Settings2 size={17} /></span></div>
          <div className="lp-demo-workspace">
            <div className="lp-preview-headings" aria-hidden="true"><span><Monitor size={13} /> Horizontal <b>16:9</b></span><span><Smartphone size={13} /> Vertical <b>9:16</b></span></div>
            <div className="lp-demo-outputs" aria-hidden="true"><DemoFrame scene={scene} /><DemoFrame scene={scene} portrait /></div>
            <div className="lp-demo-controls">
              <div className="lp-scene-buttons" role="group" aria-label="Explorar cenas na demonstração">
                {scenes.map(({ id, label, icon: Icon }) => <Button key={id} variant="ghost" aria-pressed={scene === id} onClick={() => setScene(id)}><Icon size={14} aria-hidden="true" /><span>{label}</span></Button>)}
              </div>
              <div className="lp-demo-audio" aria-hidden="true"><Mic size={13} /><div className="lp-audio-bars">{Array.from({ length: 10 }, (_, index) => <i key={index} style={{ animationDelay: `${index * -0.13}s` }} />)}</div></div>
            </div>
          </div>
        </div>
      </div>
      <div className="lp-demo-caption"><span><span className="lp-linked-frames"><i /><i /></span> A mesma ideia. Dois vídeos, ao mesmo tempo.</span><Button variant="ghost" className="lp-motion-toggle" onClick={() => setPaused(!paused)} aria-label={paused ? "Reproduzir animação da prévia" : "Pausar animação da prévia"}>{paused ? <Play size={12} /> : <Pause size={12} />}<span>{paused ? "Reproduzir animação" : "Pausar animação"}</span></Button></div>
    </div>
  );
}

function SceneIllustration() {
  return (
    <div className="lp-scene-illustration" aria-hidden="true">
      <div className="lp-compose-canvas"><Slide /><div className="lp-compose-camera"><img src="/scenes/mascot-concept.webp" alt="" width="960" height="540" loading="lazy" /><i /><i /><i /><i /></div><span className="lp-compose-cursor"><MousePointer2 size={21} fill="currentColor" /><span>Seu enquadramento</span></span></div>
      <div className="lp-layer-stack"><span><Layers size={14} /> Suas camadas <Plus size={13} /></span><div><Camera size={13} /><span>Câmera</span><i /></div><div><Monitor size={13} /><span>Apresentação</span><i /></div><div><span className="lp-text-icon">T</span><span>Seu título</span><i /></div></div>
      <span className="lp-compose-note"><Check size={12} /> Um enquadramento para cada formato.</span>
    </div>
  );
}

const questions = [
  ["Preciso instalar algum programa?", "O estúdio funciona direto em um navegador compatível. Ao preparar sua gravação, você escolhe e autoriza a câmera, o microfone e a tela que quer compartilhar."],
  ["Os dois vídeos são gravados ao mesmo tempo?", "Sim. Uma mesma sessão gera um vídeo horizontal e um vertical. Você pode ajustar o enquadramento de cada formato antes de gravar e baixar os dois arquivos ao terminar."],
  ["Onde ficam meus projetos e vídeos?", "Eles ficam salvos neste navegador, neste dispositivo. Seus vídeos não são enviados para um servidor. Baixe uma cópia para guardar: limpar os dados do navegador remove os arquivos locais."],
  ["Preciso criar uma conta para começar?", "Sim. Crie sua conta ou entre para acessar seu espaço de gravação. Depois, é só preparar suas cenas e começar."],
];

export function HomePage({ isSignedIn = false }: { isSignedIn?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const destination = isSignedIn ? "/app" : "/signup";
  useEffect(() => {
    const element = root.current;
    if (!element || window.matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return;
    const observer = new IntersectionObserver(entries => entries.forEach(entry => {
      if (entry.isIntersecting) { entry.target.classList.add("is-visible"); observer.unobserve(entry.target); }
    }), { threshold: 0.12 });
    element.classList.add("lp-has-motion");
    element.querySelectorAll("[data-reveal]").forEach(item => observer.observe(item));
    return () => { observer.disconnect(); element.classList.remove("lp-has-motion"); };
  }, []);

  return (
    <div ref={root} className="auth-shell lp-page">
      <a className="lp-skip-link" href="#conteudo">Ir para o conteúdo</a>
      <header className="lp-header"><div className="lp-header-inner"><Brand /><nav className="lp-nav-links" aria-label="Sobre o GravaSimples"><a href="#possibilidades">O estúdio</a><a href="#como-funciona">Como funciona</a><a href="#duvidas">Dúvidas</a></nav><Button asChild variant="ghost" className="lp-login"><Link to={isSignedIn ? "/app" : "/login"}>{isSignedIn ? "Meu espaço" : "Entrar"}<ArrowRight size={15} aria-hidden="true" /></Link></Button></div></header>

      <main id="conteudo" tabIndex={-1}>
        <section className="lp-hero" aria-labelledby="home-title">
          <div className="lp-hero-copy">
            <span className="lp-eyebrow"><span /> SEU ESTÚDIO, NO NAVEGADOR</span>
            <h1 id="home-title">Uma gravação.<br /><span>Dois formatos.</span></h1>
            <p>Sua câmera, sua tela e suas ideias. Grave na horizontal e na vertical ao mesmo tempo, do seu jeito.</p>
            <div className="lp-hero-actions"><Button asChild size="lg" className="lp-primary-cta"><Link to={destination}>{isSignedIn ? "Abrir meu espaço" : "Começar a gravar"}<ArrowRight size={17} aria-hidden="true" /></Link></Button><a className="lp-secondary-cta" href="#como-funciona">Veja como funciona <ArrowDown size={14} aria-hidden="true" /></a></div>
            <span className="lp-hero-note"><LockKeyhole size={12} aria-hidden="true" /> Seus vídeos ficam no seu navegador.</span>
          </div>
          <div className="lp-hero-product"><div className="lp-product-halo" aria-hidden="true" /><StudioDemo /></div>
        </section>

        <section className="lp-one-to-two" aria-label="Uma gravação gera dois arquivos de vídeo" data-reveal><div><span className="lp-number">01</span><span>Você grava<br /><strong>uma vez.</strong></span></div><span className="lp-flow-line" aria-hidden="true"><i /><ArrowRight size={21} /></span><div><span className="lp-number">02</span><span>Suas ideias ganham<br /><strong>dois formatos.</strong></span></div><p>Mais tempo para criar.<br />{" "}Mais jeitos de compartilhar.</p></section>

        <section id="possibilidades" className="lp-feature-section lp-section" aria-labelledby="feature-title">
          <div className="lp-feature-copy" data-reveal><span className="lp-section-label">ESPAÇO PARA A SUA CRIATIVIDADE</span><h2 id="feature-title">O conteúdo é seu.<br /><span>A cena também.</span></h2><p>De uma aula a uma apresentação: combine câmera, tela, imagens e textos. Prepare suas cenas e encontre o melhor enquadramento para cada vídeo.</p><ul className="lp-feature-list"><li><Check size={16} /> Câmera e tela na mesma cena</li><li><Check size={16} /> Camadas para organizar suas ideias</li><li><Check size={16} /> Enquadramentos horizontal e vertical independentes</li></ul><a className="lp-inline-link" href="#como-funciona">Conheça o caminho da sua gravação <ArrowRight size={15} /></a></div>
          <div data-reveal><SceneIllustration /></div>
        </section>

        <section id="como-funciona" className="lp-workflow" aria-labelledby="workflow-title"><div className="lp-workflow-inner"><div className="lp-workflow-heading" data-reveal><span className="lp-section-label">DA IDEIA AO VÍDEO</span><h2 id="workflow-title">Prepare. Grave.<br /><span>Compartilhe.</span></h2><p>Seu próximo conteúdo começa<br />{" "}com três passos simples.</p></div><ol className="lp-workflow-steps"><li data-reveal><span>01</span><div><h3>Monte o seu espaço</h3><p>Crie um projeto, escolha o que aparece e prepare as cenas que vão contar a sua história.</p></div><Layers size={23} /></li><li data-reveal><span>02</span><div><h3>Grave nos dois formatos</h3><p>Ajuste as duas prévias e comece. Troque entre suas cenas durante a mesma gravação.</p></div><Video size={23} /></li><li data-reveal><span>03</span><div><h3>Baixe. E dê vida à sua ideia.</h3><p>Receba um vídeo horizontal e um vertical. Baixe os arquivos para guardar e compartilhar onde fizer sentido.</p></div><Download size={23} /></li></ol></div></section>

        <section className="lp-local-section lp-section" aria-labelledby="local-title"><div className="lp-local-visual" data-reveal aria-hidden="true"><div className="lp-file lp-file-horizontal"><div><Monitor size={30} strokeWidth={1.4} /></div><span>Minha boa ideia</span><strong>Horizontal.mp4</strong><span className="lp-file-status"><Check size={11} /> Pronto para baixar</span></div><div className="lp-file lp-file-vertical"><div><Smartphone size={29} strokeWidth={1.4} /></div><span>Minha boa ideia</span><strong>Vertical.mp4</strong><span className="lp-file-status"><Check size={11} /> Pronto para baixar</span></div><span className="lp-local-lock"><LockKeyhole size={18} /></span></div><div className="lp-local-copy" data-reveal><span className="lp-section-label">SEUS VÍDEOS. SEU CONTROLE.</span><h2 id="local-title">Crie aqui.<br /><span>Leve com você.</span></h2><p>Seus projetos e suas gravações ficam neste navegador. Ao terminar, baixe os dois vídeos para guardar uma cópia e compartilhar.</p><span className="lp-local-assurance"><LockKeyhole size={15} /> Seus vídeos não são enviados para um servidor.</span></div></section>

        <section id="duvidas" className="lp-faq lp-section" aria-labelledby="faq-title"><div data-reveal><span className="lp-section-label">ANTES DO PRIMEIRO REC</span><h2 id="faq-title">Ficou alguma<br /><span>dúvida?</span></h2></div><div className="lp-faq-items" data-reveal>{questions.map(([question, answer]) => <details key={question}><summary>{question}<Plus size={18} aria-hidden="true" /></summary><p>{answer}</p></details>)}</div></section>

        <section className="lp-final-cta" aria-labelledby="final-title"><div className="lp-final-mark" aria-hidden="true"><Video size={35} strokeWidth={1.4} /><span /></div><span className="lp-section-label">A PRÓXIMA BOA IDEIA É SUA</span><h2 id="final-title">Dê o primeiro rec.</h2><p>Um espaço para criar. Dois formatos para ir além.</p><Button asChild size="lg" className="lp-primary-cta"><Link to={destination}>{isSignedIn ? "Voltar ao meu espaço" : "Criar meu espaço"}<ArrowRight size={17} aria-hidden="true" /></Link></Button></section>
      </main>

      <footer className="lp-footer"><Brand /><p>Menos complicação. Mais criação.</p><a href="#conteudo">Voltar ao topo <ArrowRight size={13} aria-hidden="true" /></a></footer>
    </div>
  );
}
