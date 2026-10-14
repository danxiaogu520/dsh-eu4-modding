export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export function object(value: Json, label = 'response'): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

export function abortError(): Error {
  return new DOMException('ParadoxCode operation cancelled', 'AbortError');
}

export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}
