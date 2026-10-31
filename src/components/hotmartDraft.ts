import type { Orientation } from "../media/types";

export interface HotmartDraft {
  title: string;
  description: string;
  orientation: Orientation;
  courseId: string;
  moduleId: string;
}
export const hotmartDraftKey = (ownerId: string, recordingId: string) =>
  `grava-hotmart-draft-v1:${ownerId}:${recordingId}`;
export const hotmartResumeKey = (ownerId: string, recordingId: string) =>
  `grava-hotmart-resume-v1:${ownerId}:${recordingId}`;

export function readHotmartDraft(ownerId: string, recordingId: string, recordingName: string, orientation: Orientation): HotmartDraft {
  const fallback: HotmartDraft = { title: recordingName, description: "", orientation, courseId: "", moduleId: "" };
  try {
    const saved = JSON.parse(sessionStorage.getItem(hotmartDraftKey(ownerId, recordingId)) || "null");
    if (!saved || typeof saved !== "object") return fallback;
    return {
      title: typeof saved.title === "string" ? saved.title.slice(0, 200) : fallback.title,
      description: typeof saved.description === "string" ? saved.description.slice(0, 10000) : "",
      orientation: saved.orientation === "portrait" ? "portrait" : "landscape",
      courseId: typeof saved.courseId === "string" ? saved.courseId : "",
      moduleId: typeof saved.moduleId === "string" ? saved.moduleId : "",
    };
  } catch { return fallback; }
}
