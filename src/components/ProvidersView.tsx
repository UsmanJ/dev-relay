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