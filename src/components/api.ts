"use client";

export class ApiError extends Error {
  constructor(message: string, public kind?: string, public status?: number) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
    headers: { "content-type": "application/json", "x-devrelay": "1" },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  if (!res.ok) {
    const d = data as { error?: string; kind?: string } | null;
    throw new ApiError(d?.error ?? `Request failed (${res.status})`, d?.kind, res.status);
  }
  return data as T;
}