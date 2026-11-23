/**
 * Kiro client-identity headers.
 *
 * Single source of truth for the Kiro IDE User-Agent / x-amz-user-agent pair
 * sent on every Kiro request (inference, model catalog, usage, profile
 * lookups, API-key validation). Kiro's client-version gate rejects stale
 * identities with HTTP 400/403 "This version of Kiro is no longer supported",
 * so all sites must build their identity here from the one version constant in
 * `../config/kiroClient.js`.
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
 * @returns {string}
 */
export function kiroUserAgent(machineId) {
  return (
    `aws-sdk-js/${KIRO_RUNTIME_SDK_VERSION} ua/2.1 ` +
    `os/${KIRO_AGENT_OS}#${KIRO_AGENT_OS_VERSION} ` +
    `lang/js md/nodejs#${KIRO_NODE_VERSION} ` +
    `api/codewhispererruntime#${KIRO_RUNTIME_SDK_VERSION} m/N,E ` +
    `KiroIDE-${KIRO_VERSION}-${machineId}`
  );
}

/**
 * Build the short x-amz-user-agent form.
 *
 * @param {string} machineId
 * @returns {string}
 */
export function kiroAmzUserAgent(machineId) {
  return `aws-sdk-js/${KIRO_RUNTIME_SDK_VERSION} KiroIDE-${KIRO_VERSION}-${machineId}`;
}

/**
 * Build the User-Agent / x-amz-user-agent header pair for a credential.
 * Header names are lower-case; callers that need different casing can remap.
 *
 * @param {object} [credentials]
 * @returns {{ "User-Agent": string, "x-amz-user-agent": string }}
 */
export function buildKiroIdentityHeaders(credentials) {
  const machineId = kiroMachineId(credentials);
  return {
    "User-Agent": kiroUserAgent(machineId),
    "x-amz-user-agent": kiroAmzUserAgent(machineId),
  };
}
