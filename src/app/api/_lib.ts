import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { HubError } from "@/core/util";
import { TransitionError } from "@/core/state";
import { redact } from "@/core/redact";

const LOCAL_HOSTS = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/**
 * Local-only API guard:
 *  - Host must be loopback (defeats DNS-rebinding attacks from web pages).
 *  - Mutations must carry `x-devrelay: 1` (a custom header forces a CORS preflight,
 *    which this server never approves, so other sites cannot call the API) and,
 *    when present, Origin must be loopback too.
 */
export function guard(req: Request): NextResponse | null {
  const host = req.headers.get("host") ?? "";
  if (!LOCAL_HOSTS.test(host)) return NextResponse.json({ error: "DevRelay only accepts loopback requests." }, { status: 403 });
  if (req.method !== "GET" && req.method !== "HEAD") {
    if (req.headers.get("x-devrelay") !== "1") return NextResponse.json({ error: "Missing x-devrelay header." }, { status: 403 });
    const origin = req.headers.get("origin");
    if (origin && !LOCAL_HOSTS.test(origin.replace(/^https?:\/\//, ""))) return NextResponse.json({ error: "Cross-origin request refused." }, { status: 403 });
  }
  return null;
}

export function errorResponse(e: unknown): NextResponse {
  if (e instanceof HubError) return NextResponse.json({ error: redact(e.message), kind: e.kind }, { status: e.status });
  if (e instanceof TransitionError) return NextResponse.json({ error: e.message, kind: "conflict" }, { status: 409 });
  if (e instanceof ZodError) return NextResponse.json({ error: e.issues.slice(0, 6).map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "), kind: "validation" }, { status: 400 });
  console.error(e);
  return NextResponse.json({ error: redact((e as Error)?.message ?? "Internal error"), kind: "internal" }, { status: 500 });
}

export async function handle(req: Request, fn: () => Promise<unknown> | unknown): Promise<NextResponse> {
  const blocked = guard(req);
  if (blocked) return blocked;
  try {
    return NextResponse.json(await fn());
  } catch (e) {
    return errorResponse(e);
  }
}

export async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const j = await req.json();
    return j && typeof j === "object" ? (j as Record<string, unknown>) : {};
  } catch {
    throw new HubError("Request body must be JSON.", "validation");
  }
}