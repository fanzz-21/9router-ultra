"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card } from "@/shared/components";
import { getModelsByProviderId, PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";
import { FREE_PROVIDERS, isAnthropicCompatibleProvider, isOpenAICompatibleProvider } from "@/shared/constants/providers";
import { getPricingForModel, calculateCostFromTokens, formatCost as formatCostUsd } from "open-sse/providers/pricing.js";
import { describeEmptyResponse } from "@/shared/utils/modelResponse";

const STORAGE_KEYS = {
  selectedModelIds: "compare-models.selectedModelIds",
  apiKeyId: "compare-models.apiKeyId",
  draft: "compare-models.draft",
};

// Match serenhope's arena: up to four contenders stay legible side-by-side and
// keep the parallel fan-out bounded.
const MAX_MODELS = 4;

const ALIAS_TO_PROVIDER_ID = Object.fromEntries(
  Object.entries(PROVIDER_ID_TO_ALIAS || {}).map(([id, alias]) => [alias, id])
);

function safeParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function textValue(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join(" ");
  if (typeof value === "object") {
    if (typeof value.message === "string") return value.message;
    if (typeof value.error === "string") return value.error;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function humanize(value = "") {
  return String(value)
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim() || "Unknown";
}

// Read streamed assistant text from an SSE chunk — mirrors basic-chat so both
// pages parse the same delta shapes (chat.completions + responses fallbacks).
function readAssistantText(chunk) {
  if (!chunk || typeof chunk !== "object") return "";
  const choice = chunk.choices?.[0];
  const delta = choice?.delta || {};
  const pieces = [delta.content, choice?.message?.content, chunk.output_text, chunk.text]
    .map(textValue)
    .filter(Boolean);
  return pieces[0] || "";
}

// Pull reasoning/thinking text off a streamed chunk so slow reasoners show
// activity before the final answer lands.
function readReasoningText(chunk) {
  if (!chunk || typeof chunk !== "object") return "";
  const choice = chunk.choices?.[0];
  const delta = choice?.delta || {};
  const pieces = [delta.reasoning_content, delta.reasoning, delta.thinking, choice?.message?.reasoning_content]
    .map(textValue)
    .filter(Boolean);
  return pieces[0] || "";
}

// Pull a usage block off any chunk (terminal usage chunks carry it top-level).
function readUsage(chunk) {
  if (!chunk || typeof chunk !== "object") return null;
  const usage = chunk.usage || chunk.response?.usage || null;
  if (!usage || typeof usage !== "object") return null;
  const prompt = usage.prompt_tokens ?? usage.input_tokens ?? null;
  const completion = usage.completion_tokens ?? usage.output_tokens ?? null;
  const total = usage.total_tokens ?? (
    prompt != null && completion != null ? prompt + completion : null
  );
  if (prompt == null && completion == null && total == null) return null;
  return {
    prompt,
    completion,
    total,
    prompt_tokens: prompt ?? undefined,
    completion_tokens: completion ?? undefined,
    total_tokens: total ?? undefined,
  };
}

// Read an explicit finish_reason off a chunk so empty-response hints can explain
// length/filter cut-offs.
function readFinishReason(chunk) {
  if (!chunk || typeof chunk !== "object") return "";
  return textValue(chunk.choices?.[0]?.finish_reason || chunk.stop_reason || "");
}

function getProviderLabel(connection) {
  return connection?.name || humanize(connection?.provider || connection?.id || "provider");
}

function normalizeStaticModel(model, connection) {
  if (!model?.id) return null;
  return {
    id: `${connection.provider}/${model.id}`,
    requestModel: `${connection.provider}/${model.id}`,
    name: model.name || model.id,
    providerId: connection.provider,
    providerName: getProviderLabel(connection),
    source: "static",
  };
}

function normalizeLiveModel(model, connection) {
  const rawId = typeof model === "string" ? model : model?.id || model?.name || model?.model || "";
  if (!rawId) return null;

  const displayName = typeof model === "string"
    ? model
    : model?.name || model?.displayName || rawId;

  let requestModel = rawId;
  const isCompatible = isOpenAICompatibleProvider(connection.provider) || isAnthropicCompatibleProvider(connection.provider);
  if (isCompatible && !rawId.includes("/")) {
    requestModel = `${connection.provider}/${rawId}`;
  }

  return {
    id: requestModel,
    requestModel,
    name: displayName,
    providerId: connection.provider,
    providerName: getProviderLabel(connection),
    source: "live",
  };
}

function parseProviderModelsPayload(data) {
  if (Array.isArray(data?.models)) return data.models;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data)) return data;
  return [];
}

function dedupeModels(models) {
  const map = new Map();
  for (const model of models) {
    if (!model?.id) continue;
    if (!map.has(model.id)) map.set(model.id, model);
  }
  return Array.from(map.values());
}

// No-auth free providers serve through the router's virtual connection, so they
// need no stored connection. Surface their static models as virtual groups so
// Compare works on a fresh install instead of dead-ending. (Same fallback as
// basic-chat.)
function buildFreeProviderGroups() {
  const groups = [];
  for (const provider of Object.values(FREE_PROVIDERS || {})) {
    if (!provider?.noAuth || provider.hidden) continue;
    const kinds = Array.isArray(provider.serviceKinds) && provider.serviceKinds.length > 0
      ? provider.serviceKinds
      : ["llm"];
    if (!kinds.includes("llm")) continue;
    const connection = { id: "noauth", provider: provider.id, name: provider.name || humanize(provider.id) };
    const models = getModelsByProviderId(provider.id)
      .map((model) => normalizeStaticModel(model, connection))
      .filter(Boolean);
    if (!models.length) continue;
    groups.push({
      providerId: provider.id,
      providerName: connection.name,
      providerType: "free",
      connections: [connection],
      models: dedupeModels(models).sort((a, b) => a.name.localeCompare(b.name)),
    });
  }
  return groups.sort((a, b) => a.providerName.localeCompare(b.providerName));
}

// Split a request model id into (provider, model) so pricing.js can resolve it.
// Mirrors arena's splitModel: an alias prefix (cc, gc, ...) maps back to the
// provider id pricing tables are keyed on.
function splitModel(value) {
  const str = String(value || "").trim();
  if (!str.includes("/")) return { provider: null, model: str };
  const firstSlash = str.indexOf("/");
  const prefix = str.slice(0, firstSlash);
  return { provider: ALIAS_TO_PROVIDER_ID[prefix] || prefix, model: str.slice(firstSlash + 1) };
}

// Cost is only shown when pricing.js can resolve a rate — never fabricated. A
// provider-reported cost always wins over the local estimate.
function estimateCost(model, usage) {
  if (!usage) return null;
  const { provider, model: bareModel } = splitModel(model?.requestModel || model?.id || "");
  const pricing = getPricingForModel(provider, bareModel);
  if (!pricing) return null;
  const cost = calculateCostFromTokens(usage, pricing);
  return Number.isFinite(cost) ? cost : null;
}

// Read a provider-reported cost straight off a chunk when present.
function readReportedCost(chunk) {
  if (!chunk || typeof chunk !== "object") return null;
  const candidates = [chunk.cost, chunk.usage?.cost, chunk.usage?.total_cost, chunk.response?.usage?.cost];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return null;
}

function formatMs(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

// Battle costs are usually sub-cent, so two decimals would render every row as
// $0.00. Mirrors arena's showCost.
function showCost(cost) {
  if (cost === null || cost === undefined || Number.isNaN(cost)) return "n/a";
  if (cost >= 0.01) return formatCostUsd(cost);
  if (cost < 0.0001) return `$${cost.toExponential(1)}`;
  return `$${cost.toFixed(4)}`;
}

// A stopped card keeps its partial text, so it needs a sentence of its own.
function stoppedNote(text, thinking) {
  const lines = String(text || "").split("\n").filter((line) => line.trim()).length;
  if (lines) return `Stopped after ${lines} ${lines === 1 ? "line" : "lines"} of output.`;
  if (String(thinking || "").trim()) return "Stopped while the model was still reasoning.";
  return "Stopped before any output arrived.";
}

// Width of the bar for one value inside a metric. A single entrant gets a full
// bar; otherwise it is scaled against the worst value so the comparison shows.
function barPct(v, best, worst) {
  if (v == null || best == null || worst == null) return 0;
  if (best === worst) return 100;
  const lo = Math.min(best, worst);
  const hi = Math.max(best, worst);
  return Math.max(8, Math.round(((v - lo) / (hi - lo)) * 92) + 8);
}

// One metric, described once. The winner rail, the table bars and the header
// all read from this single list, so a metric can never be shown as the winner
// in one place and left unbarred in another.
const METRIC_DEFS = [
  { key: "ms", label: "Fastest", icon: "speed", color: "#f59e0b", lowerIsBetter: true, value: (r) => (r.ms == null ? null : r.ms), format: (v) => formatMs(v), hint: "total time to finish" },
  { key: "ttft", label: "First token", icon: "bolt", color: "#38bdf8", lowerIsBetter: true, value: (r) => (r.ttftMs == null ? null : r.ttftMs), format: (v) => formatMs(v), hint: "time to first token" },
  { key: "cost", label: "Cheapest", icon: "payments", color: "#22c55e", lowerIsBetter: true, value: (r) => (r.cost == null ? null : r.cost), format: (v) => showCost(v), hint: "price of this answer" },
  { key: "tokens", label: "Leanest", icon: "data_usage", color: "#a855f7", lowerIsBetter: true, value: (r) => (r.totalTokens ? r.totalTokens : null), format: (v) => String(v), hint: "tokens billed" },
  { key: "chars", label: "Longest", icon: "article", color: "#f43f5e", lowerIsBetter: false, value: (r) => (r.chars ? r.chars : null), format: (v) => String(v), hint: "characters written" },
];

// Winner per metric, computed from the same pool the table shows: only
// finished, unstopped, answered runs compete.
function metricsFor(answered) {
  return METRIC_DEFS.map((def) => {
    const withValue = answered
      .map((r) => ({ r, v: def.value(r) }))
      .filter((x) => x.v != null && !Number.isNaN(x.v));
    if (!withValue.length) return { def, winner: null, best: null, worst: null };
    const sorted = withValue.slice().sort((a, b) => (def.lowerIsBetter ? a.v - b.v : b.v - a.v));
    return { def, winner: sorted[0].r, best: sorted[0].v, worst: sorted[sorted.length - 1].v };
  });
}

/**
 * Rank finished runs. Quality can only be judged by reading, so the automatic
 * ranking is explicitly about speed + spend; a manual pick always wins.
 */
function buildRanking(models, columns) {
  return models
    .map((model) => ({ model, column: columns[model.id] }))
    .filter((entry) => {
      const status = entry.column?.status;
      return status && status !== "idle" && status !== "streaming";
    })
    .map((entry) => {
      const column = entry.column || {};
      const metrics = column.metrics || {};
      const ok = column.status !== "error";
      const answered = ok && column.kind !== "empty" && column.status !== "aborted";
      return {
        model: entry.model,
        modelId: entry.model.id,
        ok,
        answered,
        stopped: column.status === "aborted",
        ms: metrics.totalMs ?? null,
        ttftMs: metrics.ttftMs ?? null,
        totalTokens: metrics.usage?.total ?? 0,
        cost: metrics.cost ?? null,
        chars: (column.text || "").length,
      };
    })
    .sort((a, b) => {
      if (a.answered !== b.answered) return a.answered ? -1 : 1;
      if (a.ok !== b.ok) return a.ok ? -1 : 1;
      if (a.stopped !== b.stopped) return a.stopped ? 1 : -1;
      const ta = a.ms ?? Number.MAX_SAFE_INTEGER;
      const tb = b.ms ?? Number.MAX_SAFE_INTEGER;
      if (ta !== tb) return ta - tb;
      return (a.cost ?? Number.MAX_SAFE_INTEGER) - (b.cost ?? Number.MAX_SAFE_INTEGER);
    });
}

// Ticking lives on the card so a running timer never re-renders the whole grid.
function Elapsed({ startedAt }) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const id = setInterval(() => setNow(performance.now()), 500);
    return () => clearInterval(id);
  }, []);
  if (startedAt == null) return null;
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return <span className="shrink-0 font-mono text-[11px] text-text-muted tabular-nums">{`${seconds}s so far`}</span>;
}

function RankBadge({ icon, text, accent }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${accent ? "bg-primary/15 text-primary" : "border border-border-subtle bg-surface-2 text-text-muted"}`}>
      <span className="material-symbols-outlined text-[11px]">{icon}</span>
      {text}
    </span>
  );
}

// Number plus bar. The bar makes the comparison readable; the digits stay for
// exactness. A missing value shows a dash and no bar.
function MetricCell({ entry, metric, format }) {
  if (!metric) return <span className="font-mono text-text-muted tabular-nums">—</span>;
  const v = metric.def.value(entry);
  if (v == null) return <span className="font-mono text-text-muted tabular-nums">—</span>;
  const isWinner = metric.winner?.modelId === entry.modelId;
  const pct = barPct(v, metric.best, metric.worst);
  return (
    <span className="flex flex-col items-end gap-1">
      <span className={`font-mono tabular-nums ${isWinner ? "font-semibold" : "text-text-main"}`} style={isWinner ? { color: metric.def.color } : undefined}>
        {format(v)}
        {isWinner ? <span className="material-symbols-outlined ml-0.5 align-middle text-[11px] leading-none">star</span> : null}
      </span>
      <span className="block h-1 w-full min-w-[42px] max-w-[90px] overflow-hidden rounded-full bg-surface-2">
        <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: metric.def.color, opacity: isWinner ? 1 : 0.45 }} />
      </span>
    </span>
  );
}

function FinalResult({ ranked, pick, setPick, runId }) {
  // An empty 200 response is not a win, and neither is an answer the user cut
  // off, so every award needs a real finished answer.
  const metrics = useMemo(() => metricsFor(ranked.filter((r) => r.answered && !r.stopped)), [ranked]);
  const answered = ranked.filter((r) => r.answered && !r.stopped);
  const byKey = useMemo(() => Object.fromEntries(metrics.map((m) => [m.def.key, m])), [metrics]);
  const winners = {
    fastest: byKey.ms?.winner || null,
    cheapest: byKey.cost?.winner || null,
    leanest: byKey.tokens?.winner || null,
    richest: byKey.chars?.winner || null,
    firstToken: byKey.ttft?.winner || null,
  };

  const leader = ranked[0];
  const manual = pick != null ? ranked.find((r) => r.modelId === pick) : null;

  return (
    <Card padding="md" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="material-symbols-outlined text-[20px] text-amber-500">trophy</span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-text-main">Final Result</h3>
            <p className="text-[11px] text-text-muted">
              {manual ? (
                <>Your pick: <code className="font-mono">{manual.model.name}</code></>
              ) : leader?.stopped ? (
                "Every run was stopped before it finished."
              ) : leader?.answered ? (
                <><code className="font-mono">{leader.model.name}</code> answered fastest — tap “My pick” below for quality.</>
              ) : (
                "No contender answered successfully."
              )}
            </p>
          </div>
        </div>
        <span className="text-[10px] text-text-muted">run #{runId}</span>
      </div>

      {answered.length > 1 ? (
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
          {metrics.filter((m) => m.winner).map(({ def, winner, best }) => (
            <button
              key={def.key}
              type="button"
              onClick={() => setPick(winner.modelId)}
              title={`${def.hint} — tap to make it your pick`}
              className={`flex flex-col gap-1.5 rounded-xl border p-3 text-left transition-colors ${pick === winner.modelId ? "border-primary/50 bg-primary/5" : "border-border hover:border-primary/30 hover:bg-surface-2"}`}
            >
              <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                <span className="material-symbols-outlined text-[13px] leading-none" style={{ color: def.color }}>{def.icon}</span>
                {def.label}
              </span>
              <span className="font-mono text-lg font-bold leading-none tabular-nums" style={{ color: def.color }}>{def.format(best)}</span>
              <span className="truncate font-mono text-[11px] text-text-main">{winner.model.name}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-text-muted">
        <span className="material-symbols-outlined text-[12px] leading-none">info</span>
        <span>Ranked automatically on speed and spend only — bars compare the same metric across contenders. Answer quality is yours to judge, so use “My pick”.</span>
      </div>

      <div className="min-w-0 overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-border text-text-muted">
              <th className="py-2 pr-3 text-left font-medium">Model</th>
              <th className="px-3 py-2 text-right font-medium">Time</th>
              <th className="px-3 py-2 text-right font-medium">First token</th>
              <th className="px-3 py-2 text-right font-medium">Tokens</th>
              <th className="px-3 py-2 text-right font-medium">Cost</th>
              <th className="py-2 pl-3 text-right font-medium">My pick</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((entry, position) => {
              const isWinner = position === 0 && entry.answered && !entry.stopped && pick == null;
              const isPicked = pick === entry.modelId;
              return (
                <tr key={entry.modelId} className={`border-b border-border/50 last:border-0 ${isPicked ? "bg-primary/5" : ""}`}>
                  <td className="py-2 pr-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="w-4 shrink-0 text-text-muted tabular-nums">{position + 1}</span>
                      <code className="max-w-[220px] truncate font-mono text-text-main">{entry.model.name}</code>
                      {isWinner ? <RankBadge icon="trophy" text="fastest" /> : null}
                      {winners.firstToken?.modelId === entry.modelId ? <RankBadge icon="bolt" text="first token" /> : null}
                      {winners.cheapest?.modelId === entry.modelId ? <RankBadge icon="payments" text="cheapest" /> : null}
                      {winners.richest?.modelId === entry.modelId && winners.richest?.modelId !== winners.leanest?.modelId ? <RankBadge icon="article" text="longest" /> : null}
                      {entry.stopped ? <RankBadge icon="stop_circle" text="stopped" /> : null}
                      {isPicked ? <RankBadge icon="check" text="your pick" accent /> : null}
                    </div>
                    {!entry.answered && !entry.stopped ? (
                      <span className={`text-[11px] ${entry.ok ? "text-amber-500" : "text-red-500"}`}>{entry.ok ? "empty answer" : "failed"}</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right"><MetricCell entry={entry} metric={byKey.ms} format={(v) => formatMs(v)} /></td>
                  <td className="px-3 py-2 text-right"><MetricCell entry={entry} metric={byKey.ttft} format={(v) => formatMs(v)} /></td>
                  <td className="px-3 py-2 text-right"><MetricCell entry={entry} metric={byKey.tokens} format={(v) => String(v)} /></td>
                  <td className="px-3 py-2 text-right"><MetricCell entry={entry} metric={byKey.cost} format={(v) => showCost(v)} /></td>
                  <td className="py-2 pl-3 text-right">
                    <button
                      onClick={() => setPick(isPicked ? null : entry.modelId)}
                      className={`rounded-lg border px-2 py-1 text-[11px] font-medium transition-colors ${isPicked ? "border-primary bg-primary text-white" : "border-border text-text-muted hover:border-primary/50 hover:text-primary"}`}
                    >
                      {isPicked ? "picked" : "pick"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export default function CompareModelsPageClient() {
  const [providerGroups, setProviderGroups] = useState([]);
  const [loadingData, setLoadingData] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [selectedModelIds, setSelectedModelIds] = useState(() => {
    if (typeof window === "undefined") return [];
    const saved = safeParse(globalThis.localStorage.getItem(STORAGE_KEYS.selectedModelIds), []);
    return Array.isArray(saved) ? saved.slice(0, MAX_MODELS) : [];
  });
  const [apiKeys, setApiKeys] = useState([]);
  const [activeApiKeyId, setActiveApiKeyId] = useState(() => {
    if (typeof window === "undefined") return "";
    return globalThis.localStorage.getItem(STORAGE_KEYS.apiKeyId) || "";
  });
  const [draft, setDraft] = useState(() => {
    if (typeof window === "undefined") return "";
    return globalThis.localStorage.getItem(STORAGE_KEYS.draft) || "";
  });
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [isSending, setIsSending] = useState(false);
  // Per-model column state keyed by model.id.
  const [columns, setColumns] = useState({});
  const [runId, setRunId] = useState(0);
  // Manual winner pick for the Final Result card, keyed by model.id.
  const [pick, setPick] = useState(null);

  const abortControllersRef = useRef([]);
  const modelMenuRef = useRef(null);
  // Skip the very first persistence pass so SSR-hydrated defaults are not
  // written back before the user interacts.
  const hydratedRef = useRef(false);

  // API keys — same pattern as basic-chat: only keys with a value are usable,
  // and we only ever render the name + last 4 chars (the value lives solely in
  // the Authorization header at send time).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/keys", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (cancelled || !Array.isArray(data.keys)) return;
        const usable = data.keys.filter((k) => k?.key);
        setApiKeys(usable);
        const saved = globalThis.localStorage.getItem(STORAGE_KEYS.apiKeyId) || "";
        if (!saved && usable.length > 0) setActiveApiKeyId(usable[0].id);
      } catch { /* keys optional; send surfaces the error */ }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      setLoadingData(true);
      setLoadError("");

      try {
        const providersRes = await fetch("/api/providers?lite=1", { cache: "no-store" });
        const providersData = await providersRes.json().catch(() => ({}));
        const connections = Array.isArray(providersData.connections)
          ? providersData.connections.filter((connection) => connection?.isActive !== false)
          : [];

        if (connections.length === 0) {
          const freeGroups = buildFreeProviderGroups();
          if (!cancelled) {
            setProviderGroups(freeGroups);
            if (freeGroups.length === 0) setLoadError("No providers connected yet.");
          }
          return;
        }

        const providerMap = new Map();

        for (const connection of connections) {
          const providerId = connection.provider || connection.id;
          const providerName = getProviderLabel(connection);
          const providerType = isOpenAICompatibleProvider(providerId)
            ? "openai-compatible"
            : isAnthropicCompatibleProvider(providerId)
              ? "anthropic-compatible"
              : providerId;

          if (!providerMap.has(providerId)) {
            providerMap.set(providerId, {
              providerId,
              providerName,
              providerType,
              connections: [],
              models: [],
            });
          }

          const group = providerMap.get(providerId);
          group.providerName = group.providerName || providerName;
          group.providerType = group.providerType || providerType;
          group.connections.push(connection);

          const staticModels = getModelsByProviderId(providerId)
            .map((model) => normalizeStaticModel(model, connection))
            .filter(Boolean);
          group.models.push(...staticModels);
        }

        // Fetch live models once per provider (one representative connection),
        // not once per connection — group models are deduped anyway.
        const seenProviders = new Set();
        const representatives = connections.filter((connection) => {
          const pid = connection.provider || connection.id;
          if (seenProviders.has(pid)) return false;
          seenProviders.add(pid);
          return true;
        });

        const liveResults = await Promise.all(
          representatives.map(async (connection) => {
            try {
              const response = await fetch(`/api/providers/${connection.id}/models`, { cache: "no-store" });
              const data = await response.json().catch(() => ({}));
              if (!response.ok) return { connection, models: [] };
              const models = parseProviderModelsPayload(data)
                .map((model) => normalizeLiveModel(model, connection))
                .filter(Boolean);
              return { connection, models };
            } catch {
              return { connection, models: [] };
            }
          })
        );

        for (const result of liveResults) {
          const providerId = result.connection.provider || result.connection.id;
          const group = providerMap.get(providerId);
          if (!group) continue;
          group.models.push(...result.models);
        }

        const normalized = Array.from(providerMap.values())
          .map((group) => ({
            ...group,
            models: dedupeModels(group.models).sort((a, b) => a.name.localeCompare(b.name)),
          }))
          .filter((group) => group.models.length > 0)
          .sort((a, b) => a.providerName.localeCompare(b.providerName));

        if (!cancelled) {
          setProviderGroups(normalized);
          if (normalized.length === 0) {
            setLoadError("Providers connected but no models available.");
          }
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(textValue(error?.message) || "Failed to load providers/models.");
          setProviderGroups([]);
        }
      } finally {
        if (!cancelled) setLoadingData(false);
      }
    }

    loadData();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(event.target)) {
        setModelMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (!hydratedRef.current) {
      hydratedRef.current = true;
      return;
    }
    try {
      globalThis.localStorage.setItem(STORAGE_KEYS.selectedModelIds, JSON.stringify(selectedModelIds));
      globalThis.localStorage.setItem(STORAGE_KEYS.apiKeyId, activeApiKeyId);
      globalThis.localStorage.setItem(STORAGE_KEYS.draft, draft);
    } catch {
      // Ignore storage errors.
    }
  }, [selectedModelIds, activeApiKeyId, draft]);

  const modelIndex = useMemo(() => {
    const map = new Map();
    for (const group of providerGroups) {
      for (const model of group.models) {
        map.set(model.id, {
          ...model,
          providerId: group.providerId,
          providerName: group.providerName,
        });
      }
    }
    return map;
  }, [providerGroups]);

  // Resolve selected ids to live model objects; ids that no longer exist (e.g.
  // a provider was removed) are simply dropped from the view.
  const selectedModels = useMemo(
    () => selectedModelIds.map((id) => modelIndex.get(id)).filter(Boolean),
    [selectedModelIds, modelIndex]
  );

  const canSend = !isSending && selectedModels.length > 0 && draft.trim().length > 0;
  const ranked = useMemo(() => buildRanking(selectedModels, columns), [selectedModels, columns]);

  const toggleModel = (modelId) => {
    setSelectedModelIds((prev) => {
      if (prev.includes(modelId)) return prev.filter((id) => id !== modelId);
      if (prev.length >= MAX_MODELS) {
        setLoadError(`You can compare up to ${MAX_MODELS} models at once.`);
        return prev;
      }
      setLoadError("");
      return [...prev, modelId];
    });
  };

  const removeModel = (modelId) => {
    setSelectedModelIds((prev) => prev.filter((id) => id !== modelId));
    setPick((prev) => (prev === modelId ? null : prev));
  };

  const handleStop = () => {
    for (const controller of abortControllersRef.current) {
      try { controller.abort(); } catch { /* already aborted */ }
    }
  };

  const handleClear = () => {
    handleStop();
    setColumns({});
    setLoadError("");
    setPick(null);
  };

  // Stream one model's response into its own column. Errors stay local to the
  // column so a single failing model never breaks the others.
  const streamModel = async (model, requestMessages, apiKey) => {
    const controller = new AbortController();
    abortControllersRef.current.push(controller);
    const startedAt = performance.now();

    const patchColumn = (patch) => {
      setColumns((prev) => ({
        ...prev,
        [model.id]: { ...(prev[model.id] || {}), ...patch },
      }));
    };

    patchColumn({
      status: "streaming",
      text: "",
      thinking: "",
      error: "",
      hint: "",
      kind: "",
      startedAt,
      metrics: { ttftMs: null, totalMs: null, usage: null, cost: null },
    });

    let assistantText = "";
    let reasoningText = "";
    let firstTokenAt = null;
    let usage = null;
    let reportedCost = null;
    let finishReason = "";

    const computeCost = () => {
      if (reportedCost != null) return reportedCost;
      return estimateCost(model, usage);
    };

    try {
      const response = await fetch("/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: model.requestModel || model.id,
          messages: requestMessages,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(textValue(errorData.error || errorData.message || `Request failed (${response.status})`));
      }

      const reader = response.body?.getReader();
      if (!reader) {
        const data = await response.json().catch(() => ({}));
        const fallbackText = textValue(data?.choices?.[0]?.message?.content || data?.output_text || "");
        usage = readUsage(data);
        reportedCost = readReportedCost(data);
        finishReason = readFinishReason(data);
        const kind = fallbackText ? "text" : "empty";
        patchColumn({
          status: "done",
          text: fallbackText,
          kind,
          hint: kind === "empty" ? describeEmptyResponse({ finishReason, usage, thinking: reasoningText }) : "",
          metrics: { ttftMs: null, totalMs: performance.now() - startedAt, usage, cost: computeCost() },
        });
        return { modelId: model.id, text: fallbackText };
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;

          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;

          try {
            const chunk = JSON.parse(payload);
            const maybeUsage = readUsage(chunk);
            if (maybeUsage) usage = maybeUsage;
            const maybeCost = readReportedCost(chunk);
            if (maybeCost != null) reportedCost = maybeCost;
            const maybeFinish = readFinishReason(chunk);
            if (maybeFinish) finishReason = maybeFinish;

            const reasoning = readReasoningText(chunk);
            if (reasoning) {
              if (firstTokenAt == null) firstTokenAt = performance.now();
              reasoningText += reasoning;
            }

            const text = readAssistantText(chunk);
            if (text) {
              if (firstTokenAt == null) firstTokenAt = performance.now();
              assistantText += text;
            }

            if (!text && !reasoning) continue;

            patchColumn({
              text: assistantText,
              thinking: reasoningText,
              status: "streaming",
              metrics: {
                ttftMs: firstTokenAt != null ? firstTokenAt - startedAt : null,
                totalMs: performance.now() - startedAt,
                usage,
                cost: computeCost(),
              },
            });
          } catch {
            // Ignore malformed chunks.
          }
        }
      }

      const kind = assistantText.trim() ? "text" : reasoningText.trim() ? "thinking" : "empty";
      patchColumn({
        status: "done",
        text: assistantText,
        thinking: reasoningText,
        kind,
        hint: kind === "empty" ? describeEmptyResponse({ finishReason, usage, thinking: reasoningText }) : "",
        metrics: {
          ttftMs: firstTokenAt != null ? firstTokenAt - startedAt : null,
          totalMs: performance.now() - startedAt,
          usage,
          cost: computeCost(),
        },
      });
      return { modelId: model.id, text: assistantText };
    } catch (error) {
      if (error.name === "AbortError") {
        patchColumn({
          status: "aborted",
          text: assistantText,
          thinking: reasoningText,
          kind: assistantText ? "text" : reasoningText ? "thinking" : "empty",
          hint: stoppedNote(assistantText, reasoningText),
          metrics: { ttftMs: firstTokenAt != null ? firstTokenAt - startedAt : null, totalMs: performance.now() - startedAt, usage, cost: computeCost() },
        });
        return { modelId: model.id, text: assistantText };
      }
      patchColumn({
        status: "error",
        error: textValue(error?.message || error) || "Request failed.",
        metrics: { ttftMs: firstTokenAt != null ? firstTokenAt - startedAt : null, totalMs: performance.now() - startedAt, usage, cost: computeCost() },
      });
      return { modelId: model.id, text: assistantText };
    }
  };

  // Arena is single-shot: one prompt fans out to every contender and the
  // results replace the previous board rather than appending a chat turn.
  const runBattle = async () => {
    if (selectedModels.length === 0) return;

    // The LLM pipeline authenticates by API key. With keys available but none
    // picked, fail here with a clear message instead of a bare 401 mid-stream.
    const apiKey = apiKeys.find((k) => k.id === activeApiKeyId)?.key || null;
    if (apiKeys.length > 0 && !apiKey) {
      setLoadError("Pilih API key dulu untuk mengirim (buat di Endpoint & Key bila belum ada).");
      return;
    }

    const userText = draft.trim();
    if (!userText) return;

    const requestMessages = [{ role: "user", content: userText }];

    setIsSending(true);
    setLoadError("");
    setPick(null);
    setRunId((prev) => prev + 1);
    abortControllersRef.current = [];

    // Fan out one request per selected model in parallel; each streams into its
    // own column independently.
    await Promise.all(
      selectedModels.map((model) => streamModel(model, requestMessages, apiKey))
    );

    setIsSending(false);
    abortControllersRef.current = [];
  };

  const hasBoard = selectedModels.length > 0 && (ranked.length > 0 || isSending);

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      <div className="flex flex-col gap-2">
        <h1 className="flex items-center gap-2 text-xl font-bold leading-none text-text-main">
          <span className="material-symbols-outlined size-[22px] shrink-0 text-[22px] leading-none text-primary">swords</span>
          Compare Models
        </h1>
        <p className="text-sm text-text-muted">
          Send the same prompt to up to {MAX_MODELS} models and compare speed, cost and output.
        </p>
        <p className="text-[11px] text-text-muted">
          Each answer streams live, so the time to first token shows a slow model still working.
        </p>
      </div>

      {/* Prompt panel: contender picker + prompt + run/stop */}
      <Card padding="md" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div ref={modelMenuRef} className="relative">
              <button
                type="button"
                onClick={() => setModelMenuOpen((value) => !value)}
                className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-left transition-colors hover:border-primary/40"
              >
                <span className="material-symbols-outlined text-[18px] text-primary">swords</span>
                <span className="text-sm font-semibold text-text-main">Add contenders</span>
                <Badge size="sm" variant="default">{selectedModels.length}/{MAX_MODELS}</Badge>
                <span className="material-symbols-outlined text-[18px] text-text-muted">expand_more</span>
              </button>

              {modelMenuOpen ? (
                <div className="absolute left-0 top-[calc(100%+10px)] z-30 w-[min(560px,calc(100vw-2rem))] overflow-hidden rounded-[16px] border border-border bg-surface shadow-[var(--shadow-elev)]">
                  <div className="border-b border-border px-4 py-3">
                    <p className="text-xs uppercase tracking-[0.22em] text-text-muted">Models</p>
                    <p className="text-sm text-text-main">Select up to {MAX_MODELS} to compare side-by-side</p>
                  </div>
                  <div className="custom-scrollbar max-h-[60vh] overflow-y-auto p-2">
                    {providerGroups.length === 0 ? (
                      <div className="rounded-[12px] border border-dashed border-border bg-surface-2 p-4 text-sm text-text-muted">
                        {loadingData ? "Loading models…" : "No models available."}
                      </div>
                    ) : providerGroups.map((group) => (
                      <div key={group.providerId} className="mb-2 rounded-[12px] border border-border-subtle bg-surface-2/60 p-2">
                        <div className="flex items-center justify-between px-2 py-2">
                          <p className="text-sm font-semibold text-text-main">{group.providerName}</p>
                          <Badge size="sm" variant="default">{group.models.length}</Badge>
                        </div>
                        <div className="grid gap-2 sm:grid-cols-2">
                          {group.models.map((model) => {
                            const isSelected = selectedModelIds.includes(model.id);
                            const atCap = !isSelected && selectedModelIds.length >= MAX_MODELS;
                            return (
                              <button
                                key={model.id}
                                type="button"
                                disabled={atCap}
                                onClick={() => toggleModel(model.id)}
                                className={`rounded-[12px] border px-3 py-3 text-left transition-colors ${isSelected ? "border-primary/40 bg-primary/10" : atCap ? "cursor-not-allowed border-border-subtle bg-surface-2 opacity-40" : "border-border-subtle bg-surface-2 hover:border-primary/30"}`}
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <p className="truncate text-sm font-medium text-text-main">{model.name}</p>
                                    <p className="truncate font-mono text-[11px] text-text-muted">{model.requestModel}</p>
                                  </div>
                                  {isSelected ? <span className="material-symbols-outlined text-[18px] text-primary">check_circle</span> : null}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>

            {/* Selected models as removable chips */}
            {selectedModels.map((model, index) => (
              <span key={model.id} className="flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs text-text-main">
                <span className="text-text-muted">Contender {index + 1}</span>
                <span className="max-w-[12rem] truncate">{model.name}</span>
                <button type="button" onClick={() => removeModel(model.id)} className="text-text-muted hover:text-text-main" aria-label={`Remove ${model.name}`}>
                  <span className="material-symbols-outlined text-[16px]">close</span>
                </button>
              </span>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <select
              value={activeApiKeyId}
              onChange={(event) => setActiveApiKeyId(event.target.value)}
              aria-label="API key"
              className="max-w-[180px] truncate rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text-main transition-colors hover:border-primary/40 focus:border-primary/50 focus:outline-none"
            >
              {apiKeys.length === 0 ? (
                <option value="">Buat API key dulu di Endpoint &amp; Key</option>
              ) : (
                apiKeys.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name || k.id} (…{String(k.key).slice(-4)})
                  </option>
                ))
              )}
            </select>
            <Button variant="ghost" size="sm" icon="delete" onClick={handleClear} disabled={Object.keys(columns).length === 0}>
              Clear
            </Button>
          </div>
        </div>

        {selectedModels.length === 0 ? (
          <p className="text-[11px] text-text-muted">
            Add at least one contender, then write a prompt below. Free models are available without a provider.
            {apiKeys.length === 0 ? (
              <>
                {" "}Belum ada API key —{" "}
                <a href="/dashboard/endpoint" className="font-semibold text-primary underline">buat dulu di Endpoint &amp; Key</a>.
              </>
            ) : null}
          </p>
        ) : null}

        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-text-main">Prompt</label>
          <textarea
            className="min-h-[120px] w-full rounded-lg border border-border bg-surface-2 p-3 text-sm text-text-main transition-colors focus:border-primary/50 focus:outline-none"
            placeholder="Write a python script to parse CSV…"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>

        <div className="flex justify-end">
          <Button
            icon={isSending ? "stop_circle" : "play_arrow"}
            onClick={isSending ? handleStop : runBattle}
            disabled={isSending ? false : !canSend}
            variant={isSending ? "secondary" : "primary"}
          >
            {isSending ? "Stop" : "Run Battle"}
          </Button>
        </div>
      </Card>

      {loadError ? (
        <div className="flex items-start gap-3 rounded-[16px] border border-red-500/20 bg-red-500/10 px-4 py-3 text-red-500">
          <span className="material-symbols-outlined text-[20px]">error</span>
          <p className="text-sm leading-6">{loadError}</p>
        </div>
      ) : null}

      {ranked.length > 1 ? (
        <FinalResult ranked={ranked} pick={pick} setPick={setPick} runId={runId} />
      ) : null}

      {hasBoard ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {selectedModels.map((model, index) => {
            const column = columns[model.id] || {};
            const status = column.status || "idle";
            const metrics = column.metrics || {};
            const usage = metrics.usage;
            const costLabel = metrics.cost != null ? showCost(metrics.cost) : null;
            const streaming = status === "streaming";
            const hasResult = status !== "idle" && status !== "streaming";
            return (
              <Card key={model.id} padding="sm" className="flex h-full min-w-0 flex-col">
                <div className="mb-3 flex items-center justify-between gap-2 border-b border-border pb-3">
                  <div className="min-w-0">
                    <p className="truncate text-[11px] text-text-muted">Contender {index + 1} · {model.providerName}</p>
                    <p className="truncate font-mono text-sm font-semibold text-text-main">{model.name}</p>
                  </div>
                  {streaming ? (
                    <Elapsed startedAt={column.startedAt} />
                  ) : hasResult ? (
                    <span
                      className={`shrink-0 rounded px-2 py-1 font-mono text-xs ${
                        status === "error"
                          ? "bg-red-500/10 text-red-500"
                          : column.kind === "empty" || status === "aborted"
                            ? "bg-amber-500/10 text-amber-500"
                            : "bg-green-500/10 text-green-500"
                      }`}
                    >
                      {status === "error"
                        ? "failed"
                        : status === "aborted"
                          ? "stopped"
                          : column.kind === "empty"
                            ? "empty"
                            : formatMs(metrics.totalMs)}
                    </span>
                  ) : null}
                </div>

                <div className="min-w-0 flex-1 overflow-auto rounded-lg border border-border-subtle bg-surface-2/60 p-3">
                  {status === "error" ? (
                    <p className="whitespace-pre-wrap break-words text-sm leading-6 text-red-500">{column.error || "Request failed."}</p>
                  ) : streaming && !column.text && !column.thinking ? (
                    <div className="flex h-40 flex-col items-center justify-center gap-3 text-text-muted">
                      <span className="material-symbols-outlined animate-spin text-3xl">progress_activity</span>
                      <span className="text-sm">Waiting for the first token…</span>
                    </div>
                  ) : column.text || column.thinking ? (
                    <div className="flex min-w-0 flex-col gap-2">
                      {column.text ? (
                        <pre className="min-w-0 whitespace-pre-wrap break-words font-mono text-sm text-text-main">
                          {column.text}
                          {streaming ? <span className="animate-pulse">▍</span> : null}
                        </pre>
                      ) : column.thinking && (streaming || column.kind === "thinking") ? (
                        <div className="flex min-w-0 flex-col gap-1.5">
                          {!streaming ? <p className="text-[11px] text-text-muted">Only reasoning came back, with no final answer.</p> : null}
                          <pre className="min-w-0 whitespace-pre-wrap break-words font-mono text-sm text-text-muted">
                            {column.thinking}
                            {streaming ? <span className="animate-pulse">▍</span> : null}
                          </pre>
                        </div>
                      ) : null}
                      {column.text && column.thinking ? (
                        <details className="min-w-0">
                          <summary className="cursor-pointer text-[11px] text-text-muted hover:text-primary">Show the reasoning behind this answer</summary>
                          <pre className="custom-scrollbar mt-1 max-h-40 min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border-subtle bg-surface-2 p-2 text-[11px] text-text-muted">
                            {column.thinking}
                          </pre>
                        </details>
                      ) : null}
                    </div>
                  ) : column.kind === "empty" ? (
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <p className="break-words text-sm text-amber-500">{column.hint || describeEmptyResponse({})}</p>
                      {status !== "aborted" ? <p className="text-[11px] text-text-muted">The provider answered with HTTP 200 and nothing inside.</p> : null}
                    </div>
                  ) : (
                    <div className="flex h-40 items-center justify-center text-sm text-text-muted">No result</div>
                  )}

                  {status === "aborted" && column.kind !== "empty" && column.hint ? (
                    <p className="mt-2 break-words text-[11px] text-amber-500">{column.hint}</p>
                  ) : null}
                </div>

                {hasResult && status !== "error" ? (
                  <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 border-t border-border/50 pt-3 text-xs text-text-muted">
                    {metrics.ttftMs != null ? <span>first token in {formatMs(metrics.ttftMs)}</span> : null}
                    {metrics.totalMs != null ? <span>total {formatMs(metrics.totalMs)}</span> : null}
                    {usage ? (
                      <>
                        <span>in {usage.prompt ?? 0}</span>
                        <span>out {usage.completion ?? 0}</span>
                        <span>total {usage.total ?? 0}</span>
                      </>
                    ) : null}
                    {costLabel ? <span>~{costLabel}</span> : null}
                  </div>
                ) : null}
              </Card>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
