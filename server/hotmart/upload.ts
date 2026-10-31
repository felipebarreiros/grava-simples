import { createHash } from 'node:crypto';
import { HotmartClient, id, object, productId, providerId, text } from './http.ts';
import {
  HotmartError, type HotmartDependencies, type HotmartSignedPart, type HotmartUploadContext,
  type HotmartUploadFile, type HotmartUploadPart, type HotmartUploadState,
} from './types.ts';

export const HOTMART_PART_SIZE = 6 * 1024 * 1024;
export const HOTMART_MAX_VIDEO_BYTES = 20 * 1024 * 1024 * 1024;
const SIGNER = 'https://api-club-upload.cb.hotmart.com/v5/upload/sign';
const FINISH = 'https://api-club-upload.cb.hotmart.com/v5/upload/finish';
const START = 'https://api-gateway.play.hotmart.com/v2/media/upload';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const queryString = (query: Record<string, string>) => Object.keys(query).sort().map(key => `${encode(key)}=${encode(query[key])}`).join('&');
const xmlEscape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);
function xmlValue(xml: string, name: string): string | undefined {
  const value = new RegExp(`<${name}>([^<]+)</${name}>`).exec(xml)?.[1];
  return value?.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}
function validateState(state: HotmartUploadState) {
  productId(state.productId); id(state.subdomain); id(state.fileId); id(state.mediaCode);
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(state.bucket) || state.bucket.includes('..') || !/^[A-Z0-9]{16,32}$/.test(state.awsKey) || !/^[a-z]{2}-[a-z]+-\d$/.test(state.region)) throw new HotmartError(400, 'invalid_upload', 'A sessão de envio não é válida.');
  if (!state.objectKey || state.objectKey.length > 2048 || /[\u0000-\u001f\\]/.test(state.objectKey) || state.objectKey.split('/').some(value => value === '.' || value === '..')) throw new HotmartError(400, 'invalid_upload', 'O destino do vídeo não é válido.');
  if (state.signerURL !== SIGNER || state.finishURL !== FINISH || !Number.isSafeInteger(state.fileSize) || state.fileSize <= 0 || state.fileSize > HOTMART_MAX_VIDEO_BYTES || state.partSize !== HOTMART_PART_SIZE) throw new HotmartError(400, 'invalid_upload', 'A configuração do envio não é válida.');
}

/** Only server-generated, owner-bound UploadState may be passed to these methods. */
export class HotmartUpload {
  private readonly client: HotmartClient;
  constructor(token: string, deps: HotmartDependencies = {}) { this.client = new HotmartClient(token, deps); }

  private endpoint(state: HotmartUploadState) {
    validateState(state);
    return { host: `${state.bucket}.s3.${state.region}.amazonaws.com`, path: `/${state.objectKey.split('/').map(encode).join('/')}` };
  }

  private async signature(state: HotmartUploadState, stringToSign: string, timestamp: string): Promise<string> {
    const url = new URL(state.signerURL);
    url.searchParams.set('to_sign', stringToSign);
    url.searchParams.set('datetime', timestamp);
    const response = await this.client.response(url.href, {}, { productId: state.productId, subdomain: state.subdomain });
    const raw = (await response.text()).trim();
    let signature = raw.replace(/^"|"$/g, '');
    if (raw.startsWith('{')) {
      try { const result = object(JSON.parse(raw)); signature = String(result.signature ?? result.sign ?? ''); } catch { /* rejected below */ }
    }
    if (!/^[a-f0-9]{64}$/i.test(signature)) throw new HotmartError(502, 'invalid_provider_response', 'A Hotmart não confirmou a assinatura do envio.');
    return signature;
  }

  private timestamp(): string { return new Date(this.client.now()).toISOString().replace(/[:-]|\.\d{3}/g, ''); }

  private async s3(state: HotmartUploadState, method: 'POST' | 'DELETE', query: Record<string, string>, body = '', mimeType = ''): Promise<string> {
    const { host, path } = this.endpoint(state);
    const timestamp = this.timestamp();
    const scope = `${timestamp.slice(0, 8)}/${state.region}/s3/aws4_request`;
    const digest = hash(body);
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonical = [method, path, queryString(query), `host:${host}\nx-amz-content-sha256:${digest}\nx-amz-date:${timestamp}\n`, signedHeaders, digest].join('\n');
    const stringToSign = ['AWS4-HMAC-SHA256', timestamp, scope, hash(canonical)].join('\n');
    const signature = await this.signature(state, stringToSign, timestamp);
    const headers: Record<string, string> = {
      Authorization: `AWS4-HMAC-SHA256 Credential=${state.awsKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'x-amz-content-sha256': digest, 'x-amz-date': timestamp,
    };
    if (mimeType) headers['Content-Type'] = mimeType;
    let response: Response;
    try {
      response = await this.client.fetch(`https://${host}${path}?${queryString(query)}`, { method, headers, ...(body ? { body } : {}), redirect: 'error', signal: AbortSignal.timeout(25000) });
    } catch { throw new HotmartError(502, 'upload_unconfirmed', 'Não foi possível confirmar a transferência do vídeo. Atualize o estado antes de tentar novamente.'); }
    const result = await response.text();
    // S3 may report an error XML inside HTTP 200 for CompleteMultipartUpload.
    if (!response.ok || /<Error(?:>|\s)/.test(result)) throw new HotmartError(502, 'upload_storage_failed', 'O armazenamento da Hotmart não concluiu o envio. Tente novamente.');
    return result;
  }

  async start(context: HotmartUploadContext, file: HotmartUploadFile): Promise<HotmartUploadState> {
    const pid = productId(context.productId);
    const subdomain = id(context.subdomain, 'subdomínio');
    const fileName = text(file.fileName, 'O nome do arquivo', 240);
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > HOTMART_MAX_VIDEO_BYTES) throw new HotmartError(400, 'invalid_video_size', 'Envie um vídeo de até 20 GB.');
    if (!['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'video/x-msvideo'].includes(file.mimeType)) throw new HotmartError(400, 'invalid_video_type', 'Envie o vídeo em MP4 ou em outro formato de vídeo compatível.');
    // ContentAdmin's current Player integration returns mediaCode at initiation,
    // enabling status checks and cleanup before lesson association.
    const config = object(await this.client.json('https://api-gateway.play.hotmart.com/v2/media/upload/config?type=PAGE_MEDIA', {}, { productId: pid }));
    const paths = object(config.paths);
    if (paths.startURL !== START || paths.signerURL !== SIGNER || paths.finishURL !== FINISH || config.publicFile === true) throw new HotmartError(502, 'upload_configuration_changed', 'A configuração de envio da Hotmart mudou. Tente novamente mais tarde.');
    if (file.size > Number(config.byteSizeLimit) || !Array.isArray(config.supportedFiles) || !config.supportedFiles.includes(file.mimeType)) throw new HotmartError(422, 'unsupported_video', 'Este vídeo excede os limites ou formatos aceitos pela Hotmart.');
    const start = object(await this.client.send(START, 'POST', {
      system: 'club_admin',
      fileRequestVo: { fileType: file.mimeType, fileName, fileSize: file.size },
      metaData: { subdomain, isPublic: false, type: 'PAGE_MEDIA', ...(Number.isFinite(file.durationSeconds) && file.durationSeconds! > 0 ? { fileDuration: file.durationSeconds } : {}) },
    }, { productId: pid }));
    const state: HotmartUploadState = {
      productId: pid, subdomain, fileId: providerId(start.id), mediaCode: providerId(start.mediaCode),
      objectKey: String(start.objectKey ?? ''), bucket: String(config.bucket ?? ''), awsKey: String(config.aws_key ?? ''),
      region: typeof config.awsRegion === 'string' ? config.awsRegion : 'us-east-1', uploadId: '',
      partSize: HOTMART_PART_SIZE, fileSize: file.size, signerURL: SIGNER, finishURL: FINISH,
      shouldSendFinishEvent: config.shouldSendFinishEvent === true, createdAt: this.client.now(),
    };
    try { validateState(state); }
    catch { throw new HotmartError(502, 'invalid_provider_response', 'A Hotmart retornou uma configuração inesperada após iniciar o envio. Confira sua biblioteca antes de tentar novamente.'); }
    const result = await this.s3(state, 'POST', { uploads: '' }, '', file.mimeType);
    const uploadId = xmlValue(result, 'UploadId');
    if (!uploadId || uploadId.length > 2048 || /[\r\n\u0000]/.test(uploadId)) throw new HotmartError(502, 'invalid_provider_response', 'A Hotmart não iniciou a transferência do vídeo.');
    return { ...state, uploadId };
  }

  async signPart(state: HotmartUploadState, partNumber: number): Promise<HotmartSignedPart> {
    const { host, path } = this.endpoint(state);
    const totalParts = Math.ceil(state.fileSize / state.partSize);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > totalParts || !state.uploadId) throw new HotmartError(400, 'invalid_part', 'A parte do vídeo não é válida.');
    const timestamp = this.timestamp();
    const scope = `${timestamp.slice(0, 8)}/${state.region}/s3/aws4_request`;
    const bytes = Math.min(state.partSize, state.fileSize - (partNumber - 1) * state.partSize);
    // Browsers supply Content-Length for the Blob body. Bind the signature to
    // that exact length so an issued part URL cannot upload an oversized part.
    const signedHeaders = 'content-length;host';
    const query = {
      partNumber: String(partNumber), uploadId: state.uploadId,
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${state.awsKey}/${scope}`,
      'X-Amz-Date': timestamp, 'X-Amz-Expires': '900', 'X-Amz-SignedHeaders': signedHeaders,
    };
    const canonical = ['PUT', path, queryString(query), `content-length:${bytes}\nhost:${host}\n`, signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n');
    const stringToSign = ['AWS4-HMAC-SHA256', timestamp, scope, hash(canonical)].join('\n');
    const signature = await this.signature(state, stringToSign, timestamp);
    return { url: `https://${host}${path}?${queryString({ ...query, 'X-Amz-Signature': signature })}`, headers: {}, expiresAt: this.client.now() + 900000 };
  }

  async completeParts(state: HotmartUploadState, parts: HotmartUploadPart[]): Promise<{ fileId: string; mediaCode: string }> {
    validateState(state);
    const expected = Math.ceil(state.fileSize / state.partSize);
    if (!Array.isArray(parts) || parts.length !== expected || expected > 10000 || !state.uploadId) throw new HotmartError(400, 'incomplete_upload', 'O vídeo ainda tem partes pendentes.');
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    for (let index = 0; index < sorted.length; index++) {
      if (sorted[index].partNumber !== index + 1 || !/^"?[a-f0-9]{32}(?:-\d+)?"?$/i.test(sorted[index].etag)) throw new HotmartError(400, 'invalid_parts', 'Não foi possível validar as partes enviadas do vídeo.');
    }
    const body = `<CompleteMultipartUpload>${sorted.map(part => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${xmlEscape(part.etag.startsWith('"') ? part.etag : `"${part.etag}"`)}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
    await this.s3(state, 'POST', { uploadId: state.uploadId }, body, 'application/xml');
    return { fileId: state.fileId, mediaCode: state.mediaCode };
  }

  async finish(state: HotmartUploadState): Promise<{ fileId: string; mediaCode: string }> {
    validateState(state);
    await this.client.send(state.finishURL, 'POST', { id: state.fileId, sendFinishEvent: state.shouldSendFinishEvent }, { productId: state.productId, subdomain: state.subdomain });
    return { fileId: state.fileId, mediaCode: state.mediaCode };
  }

  async complete(state: HotmartUploadState, parts: HotmartUploadPart[]): Promise<{ fileId: string; mediaCode: string }> {
    await this.completeParts(state, parts);
    return this.finish(state);
  }

  async abort(state: HotmartUploadState): Promise<void> {
    validateState(state);
    if (state.uploadId) await this.s3(state, 'DELETE', { uploadId: state.uploadId });
    // The modern initiation reserves a library entry before any bytes arrive.
    // Cancel only the exact media code allocated for this owner-bound upload.
    await this.client.send('https://api-gateway.play.hotmart.com/v2/folder/delete', 'POST', { codes: [state.mediaCode] }, { productId: state.productId, subdomain: state.subdomain });
  }
}
