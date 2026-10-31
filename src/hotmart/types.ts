import type { RecordingFile } from '../media/types';

export type GetHotmartSessionToken = () => Promise<string | null>;
export interface HotmartConnection {
  configured: boolean;
  connected: boolean;
  accountName?: string;
  expiresAt?: number;
  message?: string;
}
export interface HotmartCourse {
  id: string;
  name: string;
  status?: string;
  subdomain?: string;
  membershipSlug?: string;
}
export interface HotmartMembership { id: string; slug: string; name: string }
export interface HotmartLesson { id: string; title: string; published: boolean }
export interface HotmartModule { id: string; name: string; order: number; extra?: boolean; lessons: HotmartLesson[] }
export interface HotmartCourseDetail {
  course: HotmartCourse;
  modules: HotmartModule[];
  classes: { id: string; name: string; defaultClass: boolean }[];
}
export interface CreateHotmartCourseInput {
  name: string;
  description: string;
  locale: 'pt_BR' | 'en' | 'es';
  price: number;
  currency: 'BRL' | 'USD' | 'EUR';
  membershipSlug: string;
}
export interface HotmartVideoInput {
  file: RecordingFile;
  courseId: string;
  moduleId: string;
  title: string;
  description: string;
  publish: boolean;
  recordingId?: string;
}
export interface HotmartUploadProgress {
  phase: 'uploading' | 'processing' | 'creating';
  percentage: number;
}
export interface HotmartPublishResult { lessonId: string; url: string; published: boolean }
