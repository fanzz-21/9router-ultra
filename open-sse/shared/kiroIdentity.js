/**
 * Kiro client-identity headers.
 *
 * Single source of truth for the Kiro IDE User-Agent / x-amz-user-agent pair
 * sent on every Kiro request (inference, model catalog, usage, profile
 * lookups, API-key validation). Kiro's client-version gate rejects stale
 * identities with HTTP 400/403 "This version of Kiro is no longer supported".
 *
 * The client version is runtime-configurable so operators can bump it when
 * Kiro raises the gate again, WITHOUT redeploying. The version is resolved,
 * in order:
 *   1. an explicit `version` argument,
 *   2. `credentials.providerSpecificData.kiroClientVersion` (set from the
 *      per-provider override store — see the dashboard "Custom Headers" card,
 *      pseudo-header `X-Kiro-Client-Version`),
 *   3. the compiled-in default `KIRO_VERSION` (the floor / fallback).
 *
 * The machine id is a sha256 of the account's most stable identifier, so the
 * same account always presents the same id and no raw secret ever leaves the
 * process in a header.
 */

import { createHash } from "crypto";
import {
  KIRO_VERSION,
  KIRO_RUNTIME_SDK_VERSION,
  KIRO_AGENT_OS,
  KIRO_AGENT_OS_VERSION,
  KIRO_NODE_VERSION,
} from "../config/kiroClient.js";

/**
 * Pseudo-header name used to carry the runtime Kiro client version through the
 * generic per-provider override store. It is NOT a real upstream header: it is
 * read to resolve the version and stripped before any request leaves.
 */
export const KIRO_CLIENT_VERSION_HEADER = "X-Kiro-Client-Version";

// A plausible Kiro IDE semver: 2–4 dot-separated numeric segments, each 1–4
// digits. Guards the runtime value before it is spliced into the User-Agent so
// a malformed override cannot inject arbitrary text into an outbound header.
const KIRO_VERSION_RE = /^\d{1,4}(?:\.\d{1,4}){1,3}$/;

/**
 * Validate a candidate Kiro client version. Returns the trimmed version when it
 * looks like a real semver, otherwise null.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function sanitizeKiroClientVersion(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return KIRO_VERSION_RE.test(trimmed) ? trimmed : null;
}

/**
 * Resolve the effective Kiro client version from an explicit override and/or a
 * credentials object, falling back to the compiled-in default.
 *
 * @param {object} [credentials]
 * @param {string} [explicitVersion] highest-priority override
 * @returns {string}
 */
export function resolveKiroClientVersion(credentials, explicitVersion) {
  return (
    sanitizeKiroClientVersion(explicitVersion)
    || sanitizeKiroClientVersion(credentials?.providerSpecificData?.kiroClientVersion)
    || KIRO_VERSION
  );
}

/**
 * Pull the runtime version out of a per-provider override headers object
 * (`providerOverrides.kiro.headers`). Case-insensitive on the pseudo-header
 * name. Returns a sanitized version or null.
 *
 * @param {object} [overrideHeaders] map of header name -> value
 * @returns {string|null}
 */
export function kiroClientVersionFromOverrideHeaders(overrideHeaders) {
  if (!overrideHeaders || typeof overrideHeaders !== "object") return null;
  const target = KIRO_CLIENT_VERSION_HEADER.toLowerCase();
  for (const [name, value] of Object.entries(overrideHeaders)) {
    if (name.toLowerCase() === target) return sanitizeKiroClientVersion(value);
  }
  return null;
}

/**
 * Derive a stable, non-reversible machine id for a credential. Uses the most
 * stable identifier available and falls back to a fixed anonymous seed.
 *
 * @param {object} [credentials]
 * @returns {string} 64-char hex sha256
 */
export function kiroMachineId(credentials) {
  const seed =
    credentials?.providerSpecificData?.clientId
    || credentials?.refreshToken
    || credentials?.providerSpecificData?.profileArn
    || credentials?.accessToken
    || "kiro-anonymous";
  return createHash("sha256").update(String(seed)).digest("hex");
}

/**
 * Build the Kiro IDE User-Agent string (the long `aws-sdk-js ... KiroIDE-<ver>`
 * form the runtime client sends).
 *
 * @param {string} machineId
 * @param {string} [version] effective client version (default KIRO_VERSION)
 * @returns {string}
 */
export function kiroUserAgent(machineId, version = KIRO_VERSION) {
  const v = sanitizeKiroClientVersion(version) || KIRO_VERSION;
  return (
    `aws-sdk-js/${KIRO_RUNTIME_SDK_VERSION} ua/2.1 ` +
    `os/${KIRO_AGENT_OS}#${KIRO_AGENT_OS_VERSION} ` +
    `lang/js md/nodejs#${KIRO_NODE_VERSION} ` +
    `api/codewhispererruntime#${KIRO_RUNTIME_SDK_VERSION} m/N,E ` +
    `KiroIDE-${v}-${machineId}`
  );
}

/**
 * Build the short x-amz-user-agent form.
 *
 * @param {string} machineId
 * @param {string} [version] effective client version (default KIRO_VERSION)
 * @returns {string}
 */
export function kiroAmzUserAgent(machineId, version = KIRO_VERSION) {
  const v = sanitizeKiroClientVersion(version) || KIRO_VERSION;
  return `aws-sdk-js/${KIRO_RUNTIME_SDK_VERSION} KiroIDE-${v}-${machineId}`;
}

/**
 * Build the User-Agent / x-amz-user-agent header pair for a credential.
 * Header names are lower-case; callers that need different casing can remap.
 *
 * @param {object} [credentials]
 * @param {string} [explicitVersion] highest-priority version override
 * @returns {{ "User-Agent": string, "x-amz-user-agent": string }}
 */
export function buildKiroIdentityHeaders(credentials, explicitVersion) {
  const machineId = kiroMachineId(credentials);
  const version = resolveKiroClientVersion(credentials, explicitVersion);
  return {
    "User-Agent": kiroUserAgent(machineId, version),
    "x-amz-user-agent": kiroAmzUserAgent(machineId, version),
  };
}
