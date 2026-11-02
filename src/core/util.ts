import { randomBytes } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(5).toString("hex")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function truncate(s: string, max: number, marker = "\n…[truncated]…\n"): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - marker.length) / 2);
  return s.slice(0, half) + marker + s.slice(s.length - half);
}

export function safeJsonParse<T = unknown>(s: string | null | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

export class HubError extends Error {
  constructor(
    message: string,
    public readonly kind: ErrorKind = "internal",
    public readonly status = 400,
  ) {
    super(message);
    this.name = "HubError";
  }
}

export type ErrorKind =
  | "validation"
  | "not_found"
  | "conflict"
  | "auth"
  | "usage_limit"
  | "provider_unavailable"
  | "provider_error"
  | "malformed_output"
  | "timeout"
  | "cancelled"
  | "permission"
  | "git"
  | "internal";