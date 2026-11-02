/**
 * One-time, versioned acknowledgement required before DevRelay may invoke
 * Claude Code automatically (`claude-cli`). Until it is given, Claude can only
 * be used through the manual handoff (`claude-manual`).
 *
 * The acknowledgement is a record of the user's own confirmation. It does NOT
 * grant any permission that Anthropic's terms do not, and it never overrides a
 * provider restriction: if the terms do not permit your use, do not enable it.
 */
import { deleteSetting, getSetting, setSetting } from "./repo";
import { HubError } from "./util";

/** Bump when the acknowledgement text changes materially; users must re-acknowledge. */
export const CLAUDE_ACK_VERSION = 1;
const KEY = "claude_automation_ack";

export const CLAUDE_ACK_STATEMENTS: readonly string[] = [
  "I will use my own Claude Code installation, signed in to my own Claude account through Anthropic's official login. DevRelay never handles my credentials.",
  "I have read docs/PROVIDERS.md and the applicable Anthropic terms (Consumer Terms or my organisation's agreement, and Claude Code's Legal & Compliance page), and I am responsible for making sure my use complies with them.",
  "I understand that Anthropic has not explicitly confirmed whether third-party tools may trigger `claude -p` on a personal subscription, and that this acknowledgement does not override any provider restriction.",
  "I will run DevRelay only for myself, on my own machine. I will not host it for others or share my subscription through it.",
  "Automated runs consume my plan's usage limits. DevRelay stops on usage-limit errors and does not retry around them.",
];

export interface ClaudeAckState {
  acknowledged: boolean;
  version: number | null;
  acknowledgedAt: string | null;
  currentVersion: number;
  statements: readonly string[];
}

export function claudeAckState(): ClaudeAckState {
  let parsed: { version?: number; acknowledgedAt?: string } | null = null;
  try {
    const raw = getSetting(KEY);
    parsed = raw ? (JSON.parse(raw) as { version?: number; acknowledgedAt?: string }) : null;
  } catch {
    parsed = null;
  }
  const version = typeof parsed?.version === "number" ? parsed.version : null;
  return {
    acknowledged: version === CLAUDE_ACK_VERSION,
    version,
    acknowledgedAt: parsed?.acknowledgedAt ?? null,
    currentVersion: CLAUDE_ACK_VERSION,
    statements: CLAUDE_ACK_STATEMENTS,
  };
}

export function isClaudeAutomationAcknowledged(): boolean {
  return claudeAckState().acknowledged;
}

/** Record the acknowledgement. The caller must pass the exact current version shown to the user. */
export function acknowledgeClaudeAutomation(version: number): ClaudeAckState {
  if (version !== CLAUDE_ACK_VERSION) throw new HubError(`Acknowledgement text has changed (current version ${CLAUDE_ACK_VERSION}). Please review it again.`, "validation");
  setSetting(KEY, JSON.stringify({ version, acknowledgedAt: new Date().toISOString() }));
  return claudeAckState();
}

export function revokeClaudeAutomation(): ClaudeAckState {
  deleteSetting(KEY);
  return claudeAckState();
}

export const CLAUDE_ACK_REQUIRED_MESSAGE =
  "Automated Claude execution is not enabled. Review and accept the one-time acknowledgement (Providers page, or `npm run relay -- claude-automation enable --i-acknowledge`), or use the manual handoff (developer provider `claude-manual`).";
