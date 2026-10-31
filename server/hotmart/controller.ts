import { authenticate, ApiError } from '../transcription/security.ts';
import { beginHotmartLogin, completeHotmartLogin, disconnectHotmart, getHotmartAuthConfiguration, readHotmartSession } from './auth.ts';
import { HOTMART_FLOW_COOKIE, hotmartCookie, hotmartSetCookie, unsealHotmartState } from './session.ts';
import { createHotmartService } from './service.ts';
import { HotmartUpload } from './upload.ts';
import { HotmartError, type CreateHotmartCourse, type HotmartCourse, type HotmartUploadPart, type HotmartUploadState } from './types.ts';
import { id, productId, text } from './http.ts';
import { postgresHotmartOperations, type HotmartOperationRepository } from './repository.ts';

export const MAX_HOTMART_BODY_BYTES = 512 * 1024;
interface PublishResult { lessonId: string; url: string; published: boolean }
interface UploadJob {
  jobId: string;
  ownerId: string;
  hotmartUserId: string;
  state: HotmartUploadState;
  courseId: string;
  moduleId: string;
  title: string;
  description: string;
  publish: boolean;
  status: 'uploading' | 'processing' | 'ready' | 'completed' | 'aborted';
  result?: PublishResult;
}
interface PendingCourse { pending: true; requestId: string; membershipSlug: string }
interface CourseReceipt { hotmartUserId: string; value: HotmartCourse | PendingCourse }
export interface HotmartRuntime {
  env: NodeJS.ProcessEnv;
  configured: boolean;
  authenticate: (request: Request) => Promise<{ userId: string }>;
  auth: {
    begin: typeof beginHotmartLogin;
    complete: typeof completeHotmartLogin;
    read: typeof readHotmartSession;
    disconnect: typeof disconnectHotmart;
  };
  repository: HotmartOperationRepository;
  service: typeof createHotmartService;
  uploader: (token: string) => HotmartUpload;
  now: () => number;
}
export function createHotmartRuntime(env: NodeJS.ProcessEnv = process.env): HotmartRuntime {
  return {
    env, configured: getHotmartAuthConfiguration(env).configured && Boolean(env.DATABASE_URL),
    authenticate: async request => {
      try { return await authenticate(request, env); }
      catch (error) {
        if (error instanceof ApiError) throw new ApiError(error.status, error.status === 401 ? 'Entre novamente na sua conta para conectar a Hotmart.' : 'A conexão com a Hotmart ainda não está disponível.');
        throw error;
      }
    },
    auth: { begin: beginHotmartLogin, complete: completeHotmartLogin, read: readHotmartSession, disconnect: disconnectHotmart },
    repository: postgresHotmartOperations(env), service: createHotmartService,
    uploader: token => new HotmartUpload(token), now: Date.now,
  };
}
function json(body: unknown, status = 200, cookies: string[] = []): Response {
  const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
  cookies.forEach(cookie => headers.append('Set-Cookie', cookie));
  return new Response(JSON.stringify(body), { status, headers });
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new ApiError(400, 'A solicitação não é válida. Atualize a página.');
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'Confira os dados enviados.');
  return value as Record<string, unknown>;
}
async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new ApiError(415, 'Envie os dados em JSON.');
  if (Number(request.headers.get('content-length')) > MAX_HOTMART_BODY_BYTES) throw new ApiError(413, 'Os dados enviados excedem o limite.');
  const raw = await request.text();
  if (Buffer.byteLength(raw) > MAX_HOTMART_BODY_BYTES) throw new ApiError(413, 'Os dados enviados excedem o limite.');
  try { return record(JSON.parse(raw)); } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(400, 'Confira os dados enviados.'); }
}
function publicJob(job: UploadJob) {
  return { jobId: job.jobId, status: job.status, partSize: job.state.partSize, partCount: Math.ceil(job.state.fileSize / job.state.partSize), ...(job.result ? { result: job.result } : {}) };
}
function callbackRedirect(returnTo: string, status: 'connected' | 'error', cookies: string[], env: NodeJS.ProcessEnv): Response {
  let origin = 'https://callback.invalid';
  try { origin = new URL(env.HOTMART_OIDC_REDIRECT_URI || `${origin}/api/hotmart`).origin; } catch { /* Failed setup still returns a safe local redirect. */ }
  const target = new URL(returnTo, origin);
  if (target.origin !== origin || !/^\/app(?:\/|$)/.test(target.pathname)) { target.pathname = '/app'; target.search = ''; target.hash = ''; }
  target.searchParams.set('hotmart', status);
  const headers = new Headers({ Location: `${target.pathname}${target.search}${target.hash}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  cookies.forEach(cookie => headers.append('Set-Cookie', cookie));
  return new Response(null, { status: 303, headers });
}

export async function handleHotmart(request: Request, deps: HotmartRuntime): Promise<Response> {
  const url = new URL(request.url);
  const actionQuery = url.searchParams.get('action') || '';
  if (request.method === 'GET' && (actionQuery === 'callback' || (url.searchParams.has('state') && (url.searchParams.has('code') || url.searchParams.has('error'))))) {
    try {
      const connected = await deps.auth.complete(request, deps.env);
      return callbackRedirect(connected.returnTo, 'connected', connected.cookies, deps.env);
    } catch {
      const encrypted = hotmartCookie(request, HOTMART_FLOW_COOKIE);
      const flow = encrypted ? unsealHotmartState<{ returnTo: string }>('oauth', encrypted, deps.env, deps.now()) : null;
      return callbackRedirect(flow?.value.returnTo || '/app', 'error', [hotmartSetCookie(HOTMART_FLOW_COOKIE, '', 0, deps.env)], deps.env);
    }
  }
  let cookies: string[] = [];
  try {
    if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Método não permitido.' }, 405);
    const { userId } = await deps.authenticate(request);
    const body = request.method === 'POST' ? await bodyOf(request) : {};
    const action = request.method === 'POST' ? String(body.action || '') : actionQuery;
    if (request.method === 'POST') {
      const origin = request.headers.get('origin');
      const allowed = (deps.env.APP_ORIGINS || '').split(',').map(value => value.trim());
      if (!origin || !allowed.includes(origin)) throw new ApiError(403, 'Esta origem não pode alterar sua conexão com a Hotmart.');
    }
    if (action === 'disconnect' && request.method === 'POST') return json({ connected: false }, 200, deps.auth.disconnect(deps.env));
    if (!deps.configured) {
      if (action === 'status' && request.method === 'GET') return json({ configured: false, connected: false, message: 'A conexão com a Hotmart ainda não está disponível. Você pode continuar baixando seus vídeos.' });
      throw new ApiError(503, 'A conexão com a Hotmart ainda não está disponível.');
    }
    if (action === 'connect' && request.method === 'POST') {
      const flow = deps.auth.begin(userId, typeof body.returnTo === 'string' ? body.returnTo : '/app', deps.env);
      return json({ url: flow.url }, 200, flow.cookies);
    }
    const connection = await deps.auth.read(request, userId, deps.env);
    cookies = connection?.cookies || [];
    if (action === 'status' && request.method === 'GET') return json({
      configured: true, connected: Boolean(connection),
      ...(connection ? { accountName: connection.session.accountName, expiresAt: connection.session.expiresAt } : {}),
    }, 200, cookies);
    if (!connection) throw new ApiError(401, 'Conecte sua conta Hotmart para continuar.');
    const { token, hotmartUserId } = connection.session;
    const service = deps.service(token);
    const uploader = deps.uploader(token);
    const repository = deps.repository;
    const courseId = () => productId(request.method === 'GET' ? url.searchParams.get('courseId') : body.courseId);
    const jobFor = async (): Promise<UploadJob> => {
      const jobId = uuid(request.method === 'GET' ? url.searchParams.get('jobId') : body.jobId);
      const job = await repository.get<UploadJob>(userId, jobId);
      if (!job || job.ownerId !== userId || job.hotmartUserId !== hotmartUserId || deps.now() - job.state.createdAt > 24 * 3600 * 1000) throw new ApiError(404, 'Este envio não está disponível para a conta conectada.');
      return job;
    };
    if (request.method === 'GET') {
      if (action === 'courses') return json(await service.listCourses(), 200, cookies);
      if (action === 'memberships') return json(await service.listMemberships(), 200, cookies);
      if (action === 'course') return json(await service.getCourse(courseId()), 200, cookies);
      if (action === 'upload-status') {
        const job = await jobFor();
        if (job.status === 'processing') {
          const media = await service.getMediaStatus(job.courseId, job.state.mediaCode);
          if (media.status === 'failed') throw new ApiError(422, 'A Hotmart não conseguiu processar este vídeo. Confira o arquivo antes de reenviar.');
          if (media.status === 'ready') { job.status = 'ready'; await repository.update(userId, job.jobId, job, 'processing'); }
        }
        return json(publicJob((await repository.get<UploadJob>(userId, job.jobId)) || job), 200, cookies);
      }
      return json({ error: 'Operação não encontrada.' }, 404, cookies);
    }
    if (action === 'course-create') {
      const requestId = uuid(body.requestId);
      const input = record(body.input) as unknown as CreateHotmartCourse;
      const result = await repository.once<CourseReceipt>(userId, requestId, action, { hotmartUserId, input }, async () => {
        try { return { hotmartUserId, value: await service.createCourse(input, requestId) }; }
        catch (error) {
          if (error instanceof HotmartError && error.code === 'course_pending') return { hotmartUserId, value: { pending: true, requestId, membershipSlug: input.membershipSlug } };
          throw error;
        }
      });
      return json(result.value, 200, cookies);
    }
    if (action === 'course-resolve') {
      const requestId = uuid(body.requestId);
      const receipt = await repository.get<CourseReceipt>(userId, requestId);
      if (!receipt || receipt.hotmartUserId !== hotmartUserId) throw new ApiError(404, 'A solicitação do curso não foi encontrada para a conta conectada.');
      const prior = receipt.value;
      if (!('pending' in prior)) return json(prior, 200, cookies);
      try {
        const found = await service.resolveCourseCreation(requestId, prior.membershipSlug);
        await repository.update(userId, requestId, { hotmartUserId, value: found });
        return json(found, 200, cookies);
      } catch (error) {
        if (error instanceof HotmartError && error.code === 'course_pending') return json(prior, 200, cookies);
        throw error;
      }
    }
    if (action === 'module-create' || action === 'module-rename' || action === 'module-reorder') {
      const pid = courseId(), requestId = uuid(body.requestId);
      const value = await repository.once(userId, requestId, action, { hotmartUserId, courseId: pid, name: body.name, moduleId: body.moduleId, moduleIds: body.moduleIds }, async () => {
        if (action === 'module-create') return service.createModule(pid, { name: text(body.name, 'O nome do módulo', 200) });
        if (action === 'module-rename') {
          const moduleId = id(body.moduleId);
          await service.renameModule(pid, moduleId, text(body.name, 'O nome do módulo', 200));
          return (await service.listModules(pid)).find(module => module.id === moduleId);
        }
        await service.reorderModules(pid, body.moduleIds as string[]);
        return service.listModules(pid);
      });
      return json(value, 200, cookies);
    }
    if (action === 'membership-create') {
      const input = { name: text(body.name, 'O nome da área de membros', 100), slug: id(body.slug, 'endereço da área de membros') };
      const result = await repository.once(userId, uuid(body.requestId), action, { hotmartUserId, ...input }, () => service.createMembership(input));
      return json(result, 200, cookies);
    }
    if (action === 'upload-start') {
      const pid = courseId(), requestId = uuid(body.requestId), moduleId = id(body.moduleId);
      const title = text(body.title, 'O título da aula', 200), description = text(body.description, 'A descrição da aula', 20000, 0);
      if (typeof body.publish !== 'boolean' || !Number.isSafeInteger(body.fileSize) || Number(body.fileSize) <= 0 || Number(body.fileSize) > 20 * 1024 ** 3) throw new ApiError(400, 'Confira o vídeo e a forma de publicação.');
      const fileName = text(body.fileName, 'O nome do arquivo', 240), mimeType = text(body.fileType, 'O formato do vídeo', 100);
      const input = { hotmartUserId, courseId: pid, moduleId, title, description, publish: body.publish, fileName, size: body.fileSize, mimeType, recordingId: body.recordingId, durationSeconds: body.durationSeconds };
      const job = await repository.once<UploadJob>(userId, requestId, action, input, async () => {
        const detail = await service.getCourse(pid);
        if (!detail.modules.some(module => module.id === moduleId)) throw new ApiError(409, 'O módulo mudou. Atualize a estrutura do curso.');
        const state = await uploader.start({ productId: pid, subdomain: detail.course.subdomain! }, { fileName, size: Number(body.fileSize), mimeType, durationSeconds: typeof body.durationSeconds === 'number' ? body.durationSeconds : undefined });
        return { jobId: requestId, ownerId: userId, hotmartUserId, state, courseId: pid, moduleId, title, description, publish: body.publish as boolean, status: 'uploading' };
      });
      return json(publicJob(job), 200, cookies);
    }
    if (action === 'upload-sign') {
      const job = await jobFor();
      if (job.status !== 'uploading') throw new ApiError(409, 'Este envio não está recebendo mais partes.');
      return json(await uploader.signPart(job.state, Number(body.partNumber)), 200, cookies);
    }
    if (action === 'upload-complete') {
      const job = await jobFor();
      if (job.status === 'aborted') throw new ApiError(409, 'Este envio foi cancelado.');
      if (job.status === 'uploading') {
        await repository.once(userId, `${job.jobId}:s3-complete`, action, { parts: body.parts }, async () => {
          await uploader.completeParts(job.state, body.parts as HotmartUploadPart[]);
          return { completed: true };
        });
        await repository.once(userId, `${job.jobId}:finish`, action, {}, async () => { await uploader.finish(job.state); return { finished: true }; });
        job.status = 'processing';
        await repository.update(userId, job.jobId, job, 'uploading');
      }
      return json(publicJob((await repository.get<UploadJob>(userId, job.jobId)) || job), 200, cookies);
    }
    if (action === 'upload-abort') {
      const job = await jobFor();
      if (job.status === 'uploading') {
        await repository.once(userId, `${job.jobId}:abort`, action, {}, async () => { await uploader.abort(job.state); return { aborted: true }; });
        job.status = 'aborted'; await repository.update(userId, job.jobId, job, 'uploading');
      }
      return json(publicJob(job), 200, cookies);
    }
    if (action === 'lesson-create') {
      const job = await jobFor();
      if (job.result && job.status === 'completed') return json(job.result, 200, cookies);
      if (job.status !== 'ready') throw new ApiError(409, 'Aguarde o processamento do vídeo antes de criar a aula.');
      const lesson = await repository.once(userId, `${job.jobId}:lesson`, action, {}, () => service.createLesson(job.courseId, { moduleId: job.moduleId, title: job.title, description: job.description, fileId: job.state.fileId }));
      if (job.publish) await repository.once(userId, `${job.jobId}:publish`, action, {}, async () => { await service.publishLesson(job.courseId, lesson.id); return { published: true }; });
      job.result = { lessonId: lesson.id, published: job.publish, url: `https://club.hotmart.com/oauth/login?productId=${encodeURIComponent(job.courseId)}` };
      job.status = 'completed'; await repository.update(userId, job.jobId, job);
      return json(job.result, 200, cookies);
    }
    return json({ error: 'Operação não encontrada.' }, 404, cookies);
  } catch (error) {
    const expected = error instanceof ApiError || error instanceof HotmartError;
    return json({ error: expected ? error.message : 'A conexão com a Hotmart está indisponível. Tente novamente.', ...(error instanceof HotmartError ? { code: error.code } : {}) }, expected ? error.status : 503, cookies);
  }
}
