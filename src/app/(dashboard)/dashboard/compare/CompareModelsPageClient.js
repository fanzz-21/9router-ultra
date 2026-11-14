"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button } from "@/shared/components";
import { getModelsByProviderId } from "@/shared/constants/models";
import { FREE_PROVIDERS, isAnthropicCompatibleProvider, isOpenAICompatibleProvider } from "@/shared/constants/providers";

const STORAGE_KEYS = {
  selectedModelIds: "compare-models.selectedModelIds",
  apiKeyId: "compare-models.apiKeyId",
  draft: "compare-models.draft",
};

// Keep the comparison readable: cap the number of side-by-side columns so the
// grid stays legible and we never fan out an unbounded number of requests.
const MAX_MODELS = 6;

function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `cmp_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

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
  return { prompt, completion, total };
}

// Cost is only shown when the provider actually returns one — never guessed.
function readCost(chunk) {
  if (!chunk || typeof chunk !== "object") return null;
  const candidates = [chunk.cost, chunk.usage?.cost, chunk.usage?.total_cost, chunk.response?.usage?.cost];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return null;
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

function formatMs(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatCost(cost) {
  if (cost == null) return null;
  return `$${cost.toFixed(cost < 0.01 ? 6 : 4)}`;
}

const STATUS_META = {
  idle: { label: "Idle", color: "text-white/40", icon: "schedule" },
  streaming: { label: "Streaming", color: "text-blue-300", icon: "stream" },
  done: { label: "Done", color: "text-emerald-300", icon: "check_circle" },
  error: { label: "Error", color: "text-rose-300", icon: "error" },
  aborted: { label: "Stopped", color: "text-amber-300", icon: "stop_circle" },
};

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
  // Shared conversation sent to every selected model on each turn.
  const [sharedConversation, setSharedConversation] = useState([]);
  // Per-model column state keyed by model.id: { text, status, error, metrics }.
  const [columns, setColumns] = useState({});

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
  // a provider was removed) are simply dropped from the view. Persistence is
  // reconciled lazily on the next selection change, so no effect is needed.
  const selectedModels = useMemo(
    () => selectedModelIds.map((id) => modelIndex.get(id)).filter(Boolean),
    [selectedModelIds, modelIndex]
  );

  const canSend = !isSending && selectedModels.length > 0 && draft.trim().length > 0;

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
  };

  const handleStop = () => {
    for (const controller of abortControllersRef.current) {
      try { controller.abort(); } catch { /* already aborted */ }
    }
  };

  const handleClear = () => {
    handleStop();
    setSharedConversation([]);
    setColumns({});
    setLoadError("");
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
      error: "",
      metrics: { ttftMs: null, totalMs: null, usage: null, cost: null },
    });

    let assistantText = "";
    let firstTokenAt = null;
    let usage = null;
    let cost = null;

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
        cost = readCost(data);
        patchColumn({
          status: "done",
          text: fallbackText,
          metrics: { ttftMs: null, totalMs: performance.now() - startedAt, usage, cost },
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
            const maybeCost = readCost(chunk);
            if (maybeCost != null) cost = maybeCost;

            const text = readAssistantText(chunk);
            if (!text) continue;

            if (firstTokenAt == null) firstTokenAt = performance.now();
            assistantText += text;
            patchColumn({
              text: assistantText,
              status: "streaming",
              metrics: {
                ttftMs: firstTokenAt != null ? firstTokenAt - startedAt : null,
                totalMs: performance.now() - startedAt,
                usage,
                cost,
              },
            });
          } catch {
            // Ignore malformed chunks.
          }
        }
      }

      patchColumn({
        status: "done",
        text: assistantText,
        metrics: {
          ttftMs: firstTokenAt != null ? firstTokenAt - startedAt : null,
          totalMs: performance.now() - startedAt,
          usage,
          cost,
        },
      });
      return { modelId: model.id, text: assistantText };
    } catch (error) {
      if (error.name === "AbortError") {
        patchColumn({
          status: "aborted",
          metrics: { ttftMs: firstTokenAt != null ? firstTokenAt - startedAt : null, totalMs: performance.now() - startedAt, usage, cost },
        });
        return { modelId: model.id, text: assistantText };
      }
      patchColumn({
        status: "error",
        error: textValue(error?.message || error) || "Request failed.",
        metrics: { ttftMs: firstTokenAt != null ? firstTokenAt - startedAt : null, totalMs: performance.now() - startedAt, usage, cost },
      });
      return { modelId: model.id, text: assistantText };
    }
  };

  const sendPrompt = async () => {
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

    const requestMessages = [...sharedConversation, { role: "user", content: userText }];

    setSharedConversation((prev) => [...prev, { role: "user", content: userText }]);
    setDraft("");
    setIsSending(true);
    setLoadError("");
    abortControllersRef.current = [];

    // Fan out one request per selected model in parallel; each streams into its
    // own column independently.
    const results = await Promise.all(
      selectedModels.map((model) => streamModel(model, requestMessages, apiKey))
    );

    // Record the first non-empty response as the shared assistant turn so
    // follow-ups carry context for every model.
    const firstAnswer = results.find((result) => result && result.text)?.text || "";
    if (firstAnswer) {
      setSharedConversation((prev) => [...prev, { role: "assistant", content: firstAnswer }]);
    }

    setIsSending(false);
    abortControllersRef.current = [];
  };

  const handleKeyDown = (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (canSend) sendPrompt();
    }
  };

  const gridColsClass = selectedModels.length <= 1
    ? "lg:grid-cols-1"
    : selectedModels.length === 2
      ? "lg:grid-cols-2"
      : "lg:grid-cols-3";

  return (
    <div className="relative flex-1 flex flex-col h-full min-h-0 min-w-0 bg-[#212121] text-white overflow-hidden">
      <div className="relative mx-auto flex flex-1 h-full min-h-0 w-full max-w-7xl flex-col">
        {/* Toolbar: model picker + api key + clear */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-4 py-3 lg:px-6">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div ref={modelMenuRef} className="relative">
              <button
                type="button"
                onClick={() => setModelMenuOpen((value) => !value)}
                className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-left transition hover:bg-white/8"
              >
                <span className="material-symbols-outlined text-[18px] text-amber-300">compare_arrows</span>
                <span className="text-sm font-semibold text-white">Add models</span>
                <Badge size="sm" variant="default">{selectedModels.length}/{MAX_MODELS}</Badge>
                <span className="material-symbols-outlined text-[18px] text-white/70">expand_more</span>
              </button>

              {modelMenuOpen ? (
                <div className="absolute left-0 top-[calc(100%+10px)] z-30 w-[min(560px,calc(100vw-2rem))] overflow-hidden rounded-[20px] border border-white/10 bg-[#262626] shadow-2xl shadow-black/50">
                  <div className="border-b border-white/10 px-4 py-3">
                    <p className="text-xs uppercase tracking-[0.22em] text-white/45">Models</p>
                    <p className="text-sm text-white/75">Select up to {MAX_MODELS} to compare side-by-side</p>
                  </div>
                  <div className="max-h-[60vh] overflow-y-auto p-2 custom-scrollbar">
                    {providerGroups.length === 0 ? (
                      <div className="rounded-[16px] border border-dashed border-white/10 bg-white/5 p-4 text-sm text-white/55">
                        {loadingData ? "Loading models…" : "No models available."}
                      </div>
                    ) : providerGroups.map((group) => (
                      <div key={group.providerId} className="mb-2 rounded-[16px] border border-white/10 bg-black/20 p-2">
                        <div className="flex items-center justify-between px-2 py-2">
                          <p className="text-sm font-semibold text-white">{group.providerName}</p>
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
                                className={`rounded-[14px] border px-3 py-3 text-left transition ${isSelected ? "border-amber-400/40 bg-amber-500/15" : atCap ? "border-white/10 bg-white/5 opacity-40 cursor-not-allowed" : "border-white/10 bg-white/5 hover:bg-white/8"}`}
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <p className="truncate text-sm font-medium text-white">{model.name}</p>
                                    <p className="truncate text-[11px] text-white/45">{model.requestModel}</p>
                                  </div>
                                  {isSelected ? <span className="material-symbols-outlined text-[18px] text-amber-300">check_circle</span> : null}
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
            {selectedModels.map((model) => (
              <span key={model.id} className="flex items-center gap-1.5 rounded-full border border-amber-400/30 bg-amber-500/10 px-3 py-1.5 text-xs text-white">
                <span className="max-w-[12rem] truncate">{model.name}</span>
                <button type="button" onClick={() => removeModel(model.id)} className="text-white/55 hover:text-white" aria-label={`Remove ${model.name}`}>
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
              className="max-w-[180px] truncate rounded-2xl border border-white/10 bg-white/5 px-3 py-3 text-sm text-white/80 transition hover:bg-white/8"
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
            <Button variant="ghost" size="sm" icon="delete" onClick={handleClear} disabled={sharedConversation.length === 0 && Object.keys(columns).length === 0}>
              Clear
            </Button>
          </div>
        </div>

        {loadError ? (
          <div className="mx-4 mt-2 rounded-[18px] border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-rose-100 lg:mx-6">
            <div className="flex items-start gap-3">
              <span className="material-symbols-outlined text-[20px]">error</span>
              <p className="text-sm leading-6">{loadError}</p>
            </div>
          </div>
        ) : null}

        {/* Comparison columns */}
        <div className="flex flex-1 flex-col min-h-0">
          <div className="flex-1 overflow-y-auto px-4 py-4 custom-scrollbar lg:px-6">
            {selectedModels.length === 0 ? (
              <div className="flex min-h-[50vh] items-center justify-center px-4 text-center">
                <div className="max-w-xl space-y-4">
                  <div className="mx-auto flex size-16 items-center justify-center rounded-[20px] border border-white/10 bg-white/5 text-white/80">
                    <span className="material-symbols-outlined text-[30px]">compare_arrows</span>
                  </div>
                  <div className="space-y-2">
                    <h2 className="text-2xl font-semibold text-white">Compare models side-by-side</h2>
                    <p className="text-sm leading-6 text-white/60">
                      Add a few models, type one prompt, and send it to all of them at once. Each response streams into its own column with latency and token usage.
                    </p>
                    {apiKeys.length === 0 ? (
                      <p className="text-sm leading-6 text-white/60">
                        Belum ada API key —{" "}
                        <a href="/dashboard/endpoint" className="font-semibold text-violet-300 underline">
                          buat dulu di Endpoint &amp; Key
                        </a>
                        , lalu kirim prompt pertama kamu (model gratis sudah tersedia, tanpa provider).
                      </p>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : (
              <div className={`grid grid-cols-1 gap-4 ${gridColsClass}`}>
                {selectedModels.map((model) => {
                  const column = columns[model.id] || {};
                  const status = column.status || "idle";
                  const meta = STATUS_META[status] || STATUS_META.idle;
                  const metrics = column.metrics || {};
                  const usage = metrics.usage;
                  const costLabel = formatCost(metrics.cost);
                  return (
                    <div key={model.id} className="flex min-h-[40vh] flex-col overflow-hidden rounded-[20px] border border-white/10 bg-[#2f2f2f]">
                      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-white">{model.name}</p>
                          <p className="truncate text-[11px] text-white/45">{model.providerName}</p>
                        </div>
                        <span className={`flex items-center gap-1 text-[11px] font-medium ${meta.color}`}>
                          <span className="material-symbols-outlined text-[14px]">{meta.icon}</span>
                          {meta.label}
                        </span>
                      </div>

                      <div className="flex-1 overflow-y-auto px-4 py-3 custom-scrollbar">
                        {status === "error" ? (
                          <p className="whitespace-pre-wrap break-words text-sm leading-6 text-rose-200">{column.error || "Request failed."}</p>
                        ) : column.text ? (
                          <p className="whitespace-pre-wrap break-words text-[14px] leading-7 text-white/90">
                            {column.text}
                            {status === "streaming" ? <span className="inline-block animate-pulse">▋</span> : null}
                          </p>
                        ) : status === "streaming" ? (
                          <span className="inline-block animate-pulse text-white/60">▋</span>
                        ) : (
                          <p className="text-sm text-white/35">No response yet.</p>
                        )}
                      </div>

                      {/* Per-column metrics */}
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-white/10 px-4 py-2 text-[11px] text-white/55">
                        <span title="Time to first token">TTFT {formatMs(metrics.ttftMs)}</span>
                        <span title="Total time">Total {formatMs(metrics.totalMs)}</span>
                        {usage ? (
                          <span title="Token usage">
                            {usage.total != null ? `${usage.total} tok` : null}
                            {usage.prompt != null && usage.completion != null ? ` (${usage.prompt}+${usage.completion})` : null}
                          </span>
                        ) : null}
                        {costLabel ? <span title="Cost">{costLabel}</span> : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Shared prompt input */}
          <div className="shrink-0 pt-2">
            <div className="mx-auto w-full max-w-3xl px-4 pb-2">
              <div className="rounded-[26px] bg-[#2f2f2f] px-3 pt-3 pb-2 shadow-[0_0_15px_rgba(0,0,0,0.10)] ring-1 ring-white/5">
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={selectedModels.length === 0 ? "Add at least one model to compare" : "Message all selected models"}
                  rows={1}
                  className="w-full resize-none bg-transparent px-2 text-[15px] leading-6 text-white outline-none placeholder:text-white/40 custom-scrollbar max-h-[25vh] overflow-y-auto"
                />

                <div className="mt-2 flex items-center justify-between gap-3">
                  <span className="text-xs font-medium text-white/30 truncate max-w-[220px]">
                    {selectedModels.length > 0 ? `${selectedModels.length} model${selectedModels.length > 1 ? "s" : ""} selected` : "No models"}
                  </span>

                  <div className="flex items-center gap-2">
                    {isSending ? (
                      <button type="button" onClick={handleStop} className="p-2 text-white bg-white/10 hover:bg-white/20 transition rounded-full h-8 w-8 flex items-center justify-center" aria-label="Stop all">
                        <span className="material-symbols-outlined text-[16px]">stop</span>
                      </button>
                    ) : null}
                    <button onClick={sendPrompt} disabled={!canSend} className={`h-8 w-8 rounded-full flex items-center justify-center transition ${canSend ? "bg-white text-black hover:opacity-90" : "bg-white/10 text-white/30 cursor-not-allowed"}`} aria-label="Send to all">
                      <span className="material-symbols-outlined text-[16px]">arrow_upward</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <p className="mx-auto mt-2 max-w-3xl px-4 pb-4 text-center text-[11px] text-white/30">
              One prompt fans out to every selected model in parallel. Stop cancels all in-flight requests.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
