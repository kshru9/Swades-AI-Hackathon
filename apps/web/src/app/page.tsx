"use client";

import { useEffect, useState } from "react";

import { getServerApiBase } from "@/lib/chunk-upload";

const TITLE_TEXT = `
 ██████╗ ███████╗████████╗████████╗███████╗██████╗
 ██╔══██╗██╔════╝╚══██╔══╝╚══██╔══╝██╔════╝██╔══██╗
 ██████╔╝█████╗     ██║      ██║   █████╗  ██████╔╝
 ██╔══██╗██╔══╝     ██║      ██║   ██╔══╝  ██╔══██╗
 ██████╔╝███████╗   ██║      ██║   ███████╗██║  ██║
 ╚═════╝ ╚══════╝   ╚═╝      ╚═╝   ╚══════╝╚═╝  ╚═╝

 ████████╗    ███████╗████████╗ █████╗  ██████╗██╗  ██╗
 ╚══██╔══╝    ██╔════╝╚══██╔══╝██╔══██╗██╔════╝██║ ██╔╝
    ██║       ███████╗   ██║   ███████║██║     █████╔╝
    ██║       ╚════██║   ██║   ██╔══██║██║     ██╔═██╗
    ██║       ███████║   ██║   ██║  ██║╚██████╗██║  ██╗
    ╚═╝       ╚══════╝   ╚═╝   ╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝
 `;

/** UUID that is unlikely to collide; only used for list/audit smoke checks. */
const SMOKE_RECORDING_ID = "00000000-0000-0000-0000-000000000000";

type EndpointCheck = {
  label: string;
  method: string;
  path: string;
  status: "pending" | "ok" | "error";
  httpStatus?: number;
  ms?: number;
  note?: string;
};

export default function Home() {
  const [baseUrl, setBaseUrl] = useState<string>("");
  const [checks, setChecks] = useState<EndpointCheck[]>([]);
  const [configError, setConfigError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      let base: string;
      try {
        base = getServerApiBase();
      } catch {
        setConfigError("Set NEXT_PUBLIC_SERVER_URL in .env.local (e.g. http://localhost:3000).");
        setChecks([]);
        return;
      }
      if (cancelled) return;
      setBaseUrl(base);
      setConfigError(null);

      const endpoints: { label: string; method: string; path: string; validate: (res: Response) => Promise<string | undefined> }[] = [
        {
          label: "API root",
          method: "GET",
          path: "/",
          validate: async (res) => {
            const t = await res.text();
            if (!t.includes("OK")) return `Expected body to include OK, got: ${t.slice(0, 80)}`;
            return undefined;
          },
        },
        {
          label: "List chunk acks (empty recording)",
          method: "GET",
          path: `/api/chunks/recordings/${SMOKE_RECORDING_ID}`,
          validate: async (res) => {
            const j = (await res.json()) as { ok?: boolean; chunks?: unknown };
            if (j.ok !== true || !Array.isArray(j.chunks)) return "Expected { ok: true, chunks: [] }";
            return undefined;
          },
        },
        {
          label: "Audit recording (bucket HEAD scan)",
          method: "GET",
          path: `/api/chunks/recordings/${SMOKE_RECORDING_ID}/audit`,
          validate: async (res) => {
            const j = (await res.json()) as { ok?: boolean; chunks?: unknown };
            if (j.ok !== true || !Array.isArray(j.chunks)) return "Expected { ok: true, chunks: [] }";
            return undefined;
          },
        },
      ];

      setChecks(
        endpoints.map((e) => ({
          label: e.label,
          method: e.method,
          path: e.path,
          status: "pending" as const,
        }))
      );

      const results: EndpointCheck[] = [];
      for (let i = 0; i < endpoints.length; i++) {
        const e = endpoints[i];
        const url = `${base}${e.path}`;
        const started = performance.now();
        let httpStatus: number | undefined;
        let status: "ok" | "error" = "error";
        let note: string | undefined;
        try {
          const res = await fetch(url, { method: e.method });
          httpStatus = res.status;
          if (!res.ok) {
            note = await res.text().then((t) => t.slice(0, 120));
          } else {
            const err = await e.validate(res);
            if (err) note = err;
            else status = "ok";
          }
        } catch (err) {
          note = err instanceof Error ? err.message : String(err);
        }
        const ms = Math.round(performance.now() - started);
        results.push({
          label: e.label,
          method: e.method,
          path: e.path,
          status,
          httpStatus,
          ms,
          note,
        });
        if (!cancelled) {
          setChecks([...results, ...endpoints.slice(i + 1).map((x) => ({ label: x.label, method: x.method, path: x.path, status: "pending" as const }))]);
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="container mx-auto max-w-3xl px-4 py-2">
      <pre className="overflow-x-auto font-mono text-sm">{TITLE_TEXT}</pre>
      <div className="grid gap-6">
        <section className="rounded-lg border p-4">
          <h2 className="mb-2 font-medium">API status</h2>
          <p className="mb-3 text-muted-foreground text-sm">
            Read-only checks against <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{baseUrl || "NEXT_PUBLIC_SERVER_URL"}</code>.
            {" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">POST /api/chunks/upload</code> is not called from here (side effects).
          </p>
          {configError ? (
            <p className="text-destructive text-sm">{configError}</p>
          ) : (
            <ul className="space-y-2 font-mono text-xs">
              {checks.map((c) => (
                <li className="flex flex-col gap-0.5 rounded border border-border/60 bg-muted/20 px-2 py-2" key={`${c.method}${c.path}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={
                        c.status === "ok"
                          ? "text-green-600 dark:text-green-400"
                          : c.status === "error"
                            ? "text-destructive"
                            : "text-muted-foreground"
                      }
                    >
                      {c.status === "pending" ? "…" : c.status === "ok" ? "OK" : "FAIL"}
                    </span>
                    <span className="text-foreground">{c.label}</span>
                    <span className="text-muted-foreground">
                      {c.method} {c.path}
                    </span>
                    {c.ms !== undefined ? <span className="text-muted-foreground">{c.ms} ms</span> : null}
                    {c.httpStatus !== undefined ? <span className="text-muted-foreground">HTTP {c.httpStatus}</span> : null}
                  </div>
                  {c.note ? <span className="break-words text-destructive">{c.note}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
