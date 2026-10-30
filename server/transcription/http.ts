import type { VercelRequest, VercelResponse } from "@vercel/node";

export function webRequest(request: VercelRequest): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) headers.set(name, value.join(","));
    else if (value !== undefined) headers.set(name, value);
  }
  const method = request.method || "GET";
  const body =
    method === "GET" || method === "HEAD"
      ? undefined
      : typeof request.body === "string"
        ? request.body
        : JSON.stringify(request.body ?? null);
  return new Request(
    new URL(request.url || "/", "https://transcription.invalid"),
    { method, headers, ...(body === undefined ? {} : { body }) },
  );
}

export async function writeResponse(
  response: Response,
  target: VercelResponse,
): Promise<void> {
  for (const [name, value] of response.headers) target.setHeader(name, value);
  target.status(response.status).send(await response.text());
}
