/**
 * Kiro client identity constants.
 *
 * Kiro's data plane enforces a client-version gate (effective 2026-11-09):
 * requests whose User-Agent / x-amz-user-agent identify an old Kiro client are
 * rejected with HTTP 400/403 "This version of Kiro is no longer supported.
 * Please update to the latest version of Kiro to continue."
 *
 * See:
 *   - https://github.com/kirodotdev/Kiro/issues/11335
 *     (end of support for Kiro IDE < 0.11.133 on 2026-11-09)
 *   - https://github.com/kirodotdev/Kiro/issues/11966
 *     (end of support for 0.11.133–0.12.291 on 2027-01-15)
 *
 * KIRO_VERSION tracks the current stable Kiro IDE release from the official
 * update metadata so every outbound Kiro request clears the gate:
 *   https://prod.download.desktop.kiro.dev/stable/metadata-linux-x64-stable.json
 *
 * When the gate rejects this version again, bump KIRO_VERSION to the
 * `currentRelease` value from that metadata URL.
 */

// Current stable Kiro IDE release (2026-11-20). Keep >= 0.11.133 and refresh
// from the official metadata when the version gate starts rejecting it.
export const KIRO_VERSION = "1.5.11";

// AWS SDK for JavaScript major line Kiro's runtime client reports.
export const KIRO_RUNTIME_SDK_VERSION = "1.0.0";

// Node/OS fingerprint fields the runtime User-Agent carries. These mirror the
// shape a real Kiro desktop build emits; the upstream rejects malformed
// User-Agent values with a 400 "format of value '...' is invalid".
export const KIRO_AGENT_OS = "windows";
export const KIRO_AGENT_OS_VERSION = "10.0.26200";
export const KIRO_NODE_VERSION = "22.21.1";
