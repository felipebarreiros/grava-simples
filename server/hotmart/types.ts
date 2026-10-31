export interface HotmartCourse {
  id: string;
  name: string;
  ucode?: string;
  status?: string;
  subdomain?: string;
  membershipSlug?: string;
}
export interface HotmartMembership { id: string; name: string; slug: string }
export interface HotmartLesson { id: string; title: string; published: boolean; order: number }
export interface HotmartModule { id: string; name: string; order: number; extra?: boolean; lessons: HotmartLesson[] }
export interface HotmartClass { id: string; name: string; defaultClass: boolean }
export interface HotmartCourseDetail {
  course: HotmartCourse;
  modules: HotmartModule[];
  classes: HotmartClass[];
}
export interface CreateHotmartCourse {
  name: string;
  description: string;
  locale: 'pt_BR' | 'en' | 'es';
  price: number;
  currency: 'BRL' | 'USD' | 'EUR';
  membershipSlug: string;
  categoryId?: number;
  targetCountry?: string | number;
}
export interface CreateHotmartLesson { moduleId: string; title: string; description: string; fileId: string }
export interface HotmartUploadFile { fileName: string; size: number; mimeType: string; durationSeconds?: number }
export interface HotmartUploadContext { productId: string; subdomain: string }
/** Internal server state. Persist by owner; never accept an untrusted client copy. */
export interface HotmartUploadState extends HotmartUploadContext {
  fileId: string;
  mediaCode: string;
  objectKey: string;
  bucket: string;
  awsKey: string;
  region: string;
  uploadId: string;
  partSize: number;
  fileSize: number;
  signerURL: string;
  finishURL: string;
  shouldSendFinishEvent: boolean;
  createdAt: number;
}
export interface HotmartUploadPart { partNumber: number; etag: string }
export interface HotmartSignedPart { url: string; headers: Record<string, string>; expiresAt: number }
export interface HotmartMediaStatus { status: 'processing' | 'ready' | 'failed'; mediaCode: string }
export interface HotmartDependencies {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
export class HotmartError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HotmartError';
    this.status = status;
    this.code = code;
  }
}
export class HotmartCoursePendingError extends HotmartError {
  readonly ucode: string;
  readonly membershipSlug: string;
  constructor(ucode: string, membershipSlug: string) {
    super(409, 'course_pending', 'A Hotmart ainda está criando o curso. Aguarde e atualize a lista antes de tentar novamente.');
    this.ucode = ucode;
    this.membershipSlug = membershipSlug;
  }
}
