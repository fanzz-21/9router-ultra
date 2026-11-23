/**
 * Runtime Kiro client-version resolver (server side).
 *
 * Kiro's data plane enforces a client-version gate: requests identifying an old
 * Kiro client are rejected with "This version of Kiro is no longer supported".
 * The compiled-in default lives in open-sse/config/kiroClient.js, but operators
 * can override it at runtime — without redeploying — through the existing
 * per-provider override store, using the pseudo-header `X-Kiro-Client-Version`
 * on the `kiro` provider (set from the dashboard "Custom Headers" card).
 *
 * This module reads that override, validates it, and exposes helpers to stamp
 * the resolved version onto the `providerSpecificData.kiroClientVersion` that
 * every Kiro code path already carries, so inference, the model catalog, usage
 * and API-key validation all honor it from one place.
 */

import { getSettings } from "@/lib/localDb";
import {
  KIRO_CLIENT_VERSION_HEADER,
  kiroClientVersionFromOverrideHeaders,
} from "open-sse/shared/kiroIdentity.js";

export { KIRO_CLIENT_VERSION_HEADER };

/**
 * Read the operator-configured Kiro client version from the override store.
 * Returns a sanitized version string, or null when none is set / invalid (in
 * which case callers fall back to the compiled-in KIRO_VERSION default).
 *
 * @returns {Promise<string|null>}
 */
export async function getConfiguredKiroClientVersion() {
  try {
    const settings = await getSettings();
    const overrideHeaders = settings?.providerOverrides?.kiro?.headers;
    return kiroClientVersionFromOverrideHeaders(overrideHeaders);
  } catch {
    return null;
  }
}

/**
 * Return a copy of `providerSpecificData` with the configured client version
 * stamped onto `kiroClientVersion`, so the open-sse identity builder picks it
 * up. A no-op (shallow copy) when no override is configured.
 *
 * @param {object} [providerSpecificData]
 * @returns {Promise<object>}
 */
export async function withKiroClientVersion(providerSpecificData = {}) {
  const version = await getConfiguredKiroClientVersion();
  const base = providerSpecificData || {};
  return version ? { ...base, kiroClientVersion: version } : { ...base };
}
