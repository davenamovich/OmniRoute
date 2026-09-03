/**
 * Browser-TLS-impersonating HTTP client for claude.ai.
 *
 * Why this exists: Claude's Cloudflare config pins session cookies to the
 * client's TLS fingerprint (JA3/JA4) + HTTP/2 SETTINGS frame ordering.
 * Node's Undici fetch presents an obvious "not a browser" handshake and gets
 * challenged — even with a valid session. This module wraps `wreq-js`
 * (native Rust bindings with Chrome TLS profiles) to send a Chrome 149
 * handshake instead.
 *
 * Unlike the old `tls-client-node`-based implementation, wreq-js ships its
 * Linux native binary in the npm package — no runtime GitHub API download.
 */

import {
  TlsClientHangError,
  TlsClientUnavailableError,
  getWreqSession,
  resetSessionCache,
  raceWithTimeout,
  makeAbortError,
  providerFetch,
  ProviderFetchOptions,
  ProviderFetchResult,
  resolveProviderProxyUrl,
  __setTlsFetchOverrideForTesting,
  testOverride,
} from "./wreqTlsBase.ts";

const CLAUDE_PROFILE = "chrome_149"; // matches the Chrome 149 UA we send
const CLAUDE_HOST = "https://claude.ai";

export { TlsClientHangError, TlsClientUnavailableError };

export interface TlsFetchOptions extends ProviderFetchOptions {}

export interface TlsFetchResult extends ProviderFetchResult {}

// Test-only injection point — re-exported from wreqTlsBase.
export { __setTlsFetchOverrideForTesting };

/**
 * Make a single HTTP request to claude.ai with a Chrome 149 TLS fingerprint.
 *
 * Throws TlsClientUnavailableError if wreq-js failed to load.
 */
export async function tlsFetchClaude(
  url: string,
  options: TlsFetchOptions = {},
): Promise<TlsFetchResult> {
  if (testOverride) return testOverride(url, options);

  if (options.signal?.aborted) {
    throw makeAbortError(options.signal);
  }

  const session = await getWreqSession({
    profile: CLAUDE_PROFILE,
    os: "macos",
    timeout: options.timeoutMs ?? 60_000,
    proxy: resolveProviderProxyUrl(
      CLAUDE_HOST,
      options.proxyUrl,
      resolveProxyForRequest,
    ),
  });

  if (options.signal?.aborted) {
    throw makeAbortError(options.signal);
  }

  return await providerFetch(
    session,
    url,
    {
      method: options.method || "GET",
      headers: options.headers || {},
      body: options.body,
      timeoutMs: options.timeoutMs,
      signal: options.signal ?? null,
      stream: options.stream || false,
      streamEofSymbol: options.streamEofSymbol,
      proxyUrl: options.proxyUrl,
    },
    CLAUDE_HOST,
    CLAUDE_PROFILE,
  );
}

import { resolveProxyForRequest } from "../utils/proxyFetch.ts";
