// Fetch wrapper for the API. Errors carry per-field messages so forms can
// show them beside the relevant input. Nothing is reported as saved until
// the server has answered successfully.

import { QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public fields: Record<string, string> = {},
    public code?: string,
  ) {
    super(message);
  }
}

type Body = Record<string, unknown> | unknown[] | undefined;

export async function api<T>(path: string, opts: { method?: string; body?: Body; form?: FormData; signal?: AbortSignal } = {}): Promise<T> {
  const method = opts.method ?? (opts.body || opts.form ? 'POST' : 'GET');
  const headers: Record<string, string> = { 'x-scale-media': '1' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path, {
      method, headers, credentials: 'same-origin', signal: opts.signal,
      body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'Couldn’t reach the server. Check your connection and try again — nothing was saved.');
  }
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const e = (data as { error?: { message?: string; fields?: Record<string, string>; code?: string } } | null)?.error;
    if (res.status === 401 && !path.startsWith('/api/auth/')) window.dispatchEvent(new Event('auth:lost'));
    const fallback = res.status >= 502 && res.status <= 504
      ? 'The server is restarting or busy. Wait a moment and try again.'
      : `Request failed (${res.status})`;
    throw new ApiError(res.status, e?.message ?? fallback, e?.fields ?? {}, e?.code);
  }
  return data as T;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
      refetchOnWindowFocus: true,
    },
  },
});

/**
 * A mutation that refreshes every screen after it succeeds, so counts,
 * dashboards and lists never disagree with each other.
 */
export function useSave<TVars, TOut>(fn: (vars: TVars) => Promise<TOut>, opts: { onSuccess?: (out: TOut, vars: TVars) => void } = {}) {
  const qc = useQueryClient();
  return useMutation<TOut, ApiError, TVars>({
    mutationFn: fn,
    onSuccess: async (out, vars) => {
      await qc.invalidateQueries();
      opts.onSuccess?.(out, vars);
    },
    onError: async (err) => {
      // stale data: refresh so the person sees the current state
      if (err.status === 409) await qc.invalidateQueries();
    },
  });
}

export const qs = (params: Record<string, string | number | boolean | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '' && v !== false) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
