/** Capture real composed pixels in a small, opaque 16:9 JPEG suitable for localStorage. */
export function createProjectCover(canvas: HTMLCanvasElement): string {
  if (!canvas.width || !canvas.height) throw new Error('A prévia ainda não está pronta.');
  const thumbnail = document.createElement('canvas');
  thumbnail.width = 320;
  thumbnail.height = 180;
  const context = thumbnail.getContext('2d', { alpha: false });
  if (!context) throw new Error('Não foi possível criar a capa do projeto.');
  const scale = Math.max(thumbnail.width / canvas.width, thumbnail.height / canvas.height);
  const sourceWidth = thumbnail.width / scale;
  const sourceHeight = thumbnail.height / scale;
  context.drawImage(canvas, (canvas.width - sourceWidth) / 2, (canvas.height - sourceHeight) / 2, sourceWidth, sourceHeight, 0, 0, thumbnail.width, thumbnail.height);
  let dataUrl = thumbnail.toDataURL('image/jpeg', 0.65);
  if (dataUrl.length > 48_000) dataUrl = thumbnail.toDataURL('image/jpeg', 0.4);
  if (!dataUrl.startsWith('data:image/jpeg;base64,') || dataUrl.length > 64_000) throw new Error('Não foi possível salvar a capa deste projeto.');
  return dataUrl;
}
