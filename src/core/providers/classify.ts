import type { ErrorKind } from "../util";

/**
 * Classify CLI failure text into an error kind. Auth and usage-limit errors are
 * terminal for the workflow: the orchestrator stops and surfaces them; it never retries automatically.
 */
export function classifyProviderError(text: string): ErrorKind {
  const t = text.toLowerCase();
  if (/usage limit|rate[ -]?limit|too many requests|\b429\b|quota|limit reached|hit your limit|try again (in|later)|out of credits|insufficient_quota/.test(t)) return "usage_limit";
  if (/not logged in|unauthori[sz]ed|\b401\b|\b403\b|login required|please (log|sign) ?in|authentication|expired token|invalid token|auth.*fail/.test(t)) return "auth";
  if (/timed out|timeout/.test(t)) return "timeout";
  return "provider_error";
}
