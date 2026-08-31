import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

export function textResult(text: string, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError } : {}) };
}

export function jsonResult(value: unknown) {
  return textResult(JSON.stringify(value, null, 2));
}

export function cleanText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const cleaned = value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return cleaned || undefined;
}

export function positiveIntegerArg(args: any, name: string, fallback?: number): number {
  const raw = args?.[name];

  if (raw === undefined || raw === null) {
    if (fallback !== undefined) {
      return fallback;
    }
    throw new McpError(ErrorCode.InvalidParams, `${name} is required`);
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new McpError(ErrorCode.InvalidParams, `${name} must be a positive integer`);
  }

  return value;
}

export async function settleWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;

  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await task(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker)
  );

  return results;
}
