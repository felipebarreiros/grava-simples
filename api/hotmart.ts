import type { VercelRequest, VercelResponse } from '@vercel/node';
import { webRequest } from '../server/transcription/http.ts';
import { createHotmartRuntime, handleHotmart } from '../server/hotmart/controller.ts';

export default async function handler(request: VercelRequest, response: VercelResponse) {
  const result = await handleHotmart(webRequest(request), createHotmartRuntime());
  for (const [key, value] of result.headers) if (key !== 'set-cookie') response.setHeader(key, value);
  const cookies = result.headers.getSetCookie();
  if (cookies.length) response.setHeader('Set-Cookie', cookies);
  response.status(result.status).send(await result.text());
}
