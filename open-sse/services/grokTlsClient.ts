/**
 * Browser-TLS-impersonating HTTP client for x.ai / grok.com.
 *
 * Why this exists: Grok's Cloudflare config pins access to the client's TLS
 * fingerprint (JA3/JA4) + HTTP/2 SETTINGS frame ordering. Node's Undici fetch
 * presents an obvious "not a browser" handshake and gets challenged — even with
 * a valid session. This module wraps `wreq-js` (native Rust bindings with Chrome
 * TLS profiles) to send a Chrome 149 handshake instead.
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
  isCloudflareChallenge,
} from "./wreqTlsBase.ts";

const GROK_PROFILE = "chrome_149"; // closest Chrome profile to the UA we send
const GROK_HOST = "https://x.ai";

export { TlsClientHangError, TlsClientUnavailableError, isCloudflareChallenge };

export interface TlsFetchOptions extends ProviderFetchOptions {}

export interface TlsFetchResult extends ProviderFetchResult {}

// Test-only injection point — re-exported from wreqTlsBase.
export { __setTlsFetchOverrideForTesting };

/**
 * Make a single HTTP request to x.ai / grok-web with a Chrome 149 TLS fingerprint.
 *
 * Throws TlsClientUnavailableError if wreq-js failed to load.
 */
export async function tlsFetchGrok(
  url: string,
  options: TlsFetchOptions = {},
): Promise<TlsFetchResult> {
  if (testOverride) return testOverride(url, options);

  if (options.signal?.aborted) {
    throw makeAbortError(options.signal);
  }

  const session = await getWreqSession({
    profile: GROK_PROFILE,
    os: "macos",
    timeout: options.timeoutMs ?? 60_000,
    proxy: resolveProviderProxyUrl(
      GROK_HOST,
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
    GROK_HOST,
    GROK_PROFILE,
  );
}

import { resolveProxyForRequest } from "../utils/proxyFetch.ts";
