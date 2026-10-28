import type { AnalyzeRequest, AnalyzeResult, CacheMode } from "@cds-visualiser/shared";

export async function analyzeCds(request: AnalyzeRequest): Promise<AnalyzeResult> {
  const res = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | { error?: { message?: string; code?: string } }
      | null;
    throw new Error(body?.error?.message ?? `Request failed (${res.status})`);
  }

  return (await res.json()) as AnalyzeResult;
}

export interface Health {
  status: string;
  fixtureMode: boolean;
  cacheMode?: CacheMode;
  systemKey?: string;
}

export async function fetchHealth(): Promise<Health> {
  const res = await fetch("/api/health");
  return (await res.json()) as Health;
}
