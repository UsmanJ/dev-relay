"use client";

import { useState } from "react";
import { api } from "./api";
import { ProviderPanel } from "./ProviderPanel";
import type { StatusResponse } from "./types";
import { Button, Card, ErrorBanner, useApi } from "./ui";

export function ProvidersView() {
  const { data, error, setError, reload } = useApi<StatusResponse>("/api/status");
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true);
    try {
      await api("/api/status?refresh=1");
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <div className="flex items-center">
        <h1 className="text-xl font-semibold">Providers</h1>
        <Button className="ml-auto" onClick={refresh} busy={busy}>
          Re-check
        </Button>
      </div>
      <ErrorBanner error={error} onDismiss={() => setError(null)} />
      <ClaudeAutomationCard onChange={reload} />
      <ProviderPanel status={data} />
      <Card title="Registered adapters">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-zinc-500">
            <tr>
              <th className="py-1">Id</th>
              <th>Kind</th>
              <th>Billing</th>
              <th>Roles</th>
              <th>Writes code</th>
            </tr>
          </thead>
          <tbody>
            {data?.providers.map((p) => (
              <tr key={p.id} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="py-1 font-mono">{p.id}</td>
                <td>{p.kind}</td>
                <td>{p.billing}</td>
                <td>{p.roles.join(", ")}</td>
                <td>{p.writeCapable ? "yes" : "no"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-xs text-zinc-500">
          Each provider uses your own installation and login, through the vendor&apos;s official sign-in. DevRelay never reads, stores or forwards credentials. &quot;own-login&quot; providers bill against your own plan. API-metered adapters are disabled unless you explicitly opt in.
        </p>
      </Card>
    </div>
  );
}
interface AckState {
  acknowledged: boolean;
  version: number | null;
  acknowledgedAt: string | null;
  currentVersion: number;
  statements: string[];
  disabledByEnv: boolean;
}

/** One-time opt-in for automated Claude Code execution. Manual handoff is the default. */
function ClaudeAutomationCard({ onChange }: { onChange: () => Promise<void> }) {
  const ack = useApi<AckState>("/api/settings/claude-automation");
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/settings/claude-automation", { body });
      await ack.reload();
      await api("/api/status?refresh=1");
      await onChange();
      setChecked(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const s = ack.data;
  return (
    <Card title="Automated Claude Code execution">
      <ErrorBanner error={error ?? ack.error} onDismiss={() => setError(null)} />
      {!s ? null : s.acknowledged ? (
        <div className="space-y-2 text-sm">
          <p>
            <b className="text-emerald-600">Enabled</b>: acknowledged {s.acknowledgedAt ? new Date(s.acknowledgedAt).toLocaleString() : ""}. Projects whose developer provider is <code className="mono">claude-cli</code> run <code className="mono">claude -p</code> automatically, using your own Claude Code login.
          </p>
          {s.disabledByEnv && <p className="text-amber-700">DEVRELAY_DISABLE_CLAUDE_CLI=1 is set, so automated runs are blocked anyway.</p>}
          <Button variant="danger" onClick={() => post({ action: "revoke" })} busy={busy}>
            Disable automated execution
          </Button>
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <p>
            <b>Off (default).</b> Developer tasks use the <b>manual handoff</b>: DevRelay writes the task file, and you run Claude Code yourself. You can opt in to automated <code className="mono">claude -p</code> runs once you have confirmed the following:
          </p>
          <ol className="list-decimal space-y-1 pl-5">
            {s.statements.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ol>
          <p className="text-xs text-zinc-500">This records your confirmation. It does not grant permission beyond Anthropic&apos;s terms, and it does not override any provider restriction. If the terms do not permit your use, keep using the manual handoff.</p>
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="mt-1" />
            <span>I confirm all of the above (acknowledgement v{s.currentVersion}).</span>
          </label>
          <Button variant="primary" disabled={!checked || s.disabledByEnv} onClick={() => post({ action: "acknowledge", version: s.currentVersion, confirmed: true })} busy={busy}>
            Enable automated Claude execution
          </Button>
          {s.disabledByEnv && <p className="text-amber-700">DEVRELAY_DISABLE_CLAUDE_CLI=1 is set, so automated runs cannot be enabled.</p>}
        </div>
      )}
    </Card>
  );
}