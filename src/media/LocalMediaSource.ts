/** A user-selected file, decoded locally and ready for the studio compositor. */
export class LocalMediaSource {
  readonly element: HTMLCanvasElement | HTMLVideoElement;
  readonly kind: 'image' | 'video';
  readonly name: string;
  private readonly objectUrl: string;
  private disposed = false;

  private constructor(file: File, element: HTMLCanvasElement | HTMLVideoElement, objectUrl: string, kind: 'image' | 'video') {
    this.element = element;
    this.objectUrl = objectUrl;
    this.kind = kind;
    this.name = file.name;
  }

  get width(): number {
    return this.element instanceof HTMLVideoElement ? this.element.videoWidth : this.element.width;
  }

  get height(): number {
    return this.element instanceof HTMLVideoElement ? this.element.videoHeight : this.element.height;
  }

  static async open(file: File): Promise<LocalMediaSource> {
    const kind = mediaKind(file);
    const objectUrl = URL.createObjectURL(file);
    let element: HTMLCanvasElement | HTMLVideoElement | undefined;
    try {
      if (kind === 'image') {
        const image = new Image();
        const loaded = waitForLoad(image, 'load', 'Não foi possível abrir esta imagem.');
        image.src = objectUrl;
        await loaded;
        if (!image.naturalWidth || !image.naturalHeight) throw new Error('A imagem não tem dimensões válidas.');
        const scale = Math.min(1, 4096 / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Não foi possível preparar esta imagem.');
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        element = canvas;
      } else {
        const video = document.createElement('video');
        element = video;
        video.muted = true;
        video.loop = true;
        video.autoplay = true;
        video.playsInline = true;
        video.preload = 'auto';
        const loaded = waitForLoad(video, 'loadeddata', 'Não foi possível abrir este vídeo. Experimente um arquivo MP4.');
        video.src = objectUrl;
        await loaded;
        if (!video.videoWidth || !video.videoHeight) throw new Error('O vídeo não tem uma imagem válida.');
        await video.play();
      }
      return new LocalMediaSource(file, element, objectUrl, kind);
    } catch (error) {
      if (element instanceof HTMLVideoElement) releaseVideo(element);
      URL.revokeObjectURL(objectUrl);
      throw error;
    }
  }

  async play(): Promise<void> {
    if (this.disposed) throw new Error('Esta mídia já foi removida.');
    if (this.element instanceof HTMLVideoElement) await this.element.play();
  }

  pause(): void {
    if (this.element instanceof HTMLVideoElement) this.element.pause();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.element instanceof HTMLVideoElement) releaseVideo(this.element);
    else {
      this.element.width = 1;
      this.element.height = 1;
    }
    URL.revokeObjectURL(this.objectUrl);
  }
}

function mediaKind(file: File): 'image' | 'video' {
  const extension = file.name.toLowerCase().split('.').pop() ?? '';
  if (/^image\/(png|jpeg|webp|gif|avif|bmp|x-ms-bmp)$/.test(file.type) || (!file.type && ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp'].includes(extension))) return 'image';
  if (file.type.startsWith('video/') || (!file.type && ['mp4', 'mov', 'webm', 'm4v', 'ogv'].includes(extension))) return 'video';
  throw new Error('Escolha uma imagem PNG, JPG ou WebP, ou um arquivo de vídeo.');
}

function waitForLoad(element: HTMLImageElement | HTMLVideoElement, event: 'load' | 'loadeddata', message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      element.removeEventListener(event, onLoad);
      element.removeEventListener('error', onError);
    };
    const onLoad = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error(message)); };
    const timeout = setTimeout(onError, 20_000);
    element.addEventListener(event, onLoad, { once: true });
    element.addEventListener('error', onError, { once: true });
  });
}

function releaseVideo(video: HTMLVideoElement): void {
  video.pause();
  video.removeAttribute('src');
  video.load();
}
