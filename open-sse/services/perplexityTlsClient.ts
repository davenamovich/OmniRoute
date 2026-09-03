/**
 * Browser-TLS-impersonating HTTP client for www.perplexity.ai.
 *
 * Why this exists: Perplexity sits behind the same Cloudflare Enterprise
 * configuration as ChatGPT — it pins access to the client's TLS fingerprint
 * (JA3/JA4) + HTTP/2 SETTINGS frame ordering. Node's Undici fetch presents an
 * obvious "not a browser" handshake and gets challenged with a 403 "Just a
 * moment..." page from VPS/datacenter IPs — even with a valid session cookie.
 * This module wraps `wreq-js` (native Rust bindings with Firefox TLS profiles)
 * to send a Firefox 148 handshake instead. (issue #2459)
 *
 * Shares the wreq-js base implementation with chatgpt-web, claude-web, and
 * grok-web via `wreqTlsBase.ts`.
 */

import {
  TlsClientHangError,
  TlsClientUnavailableError,
  getWreqSession,
  providerFetch,
  ProviderFetchOptions,
  ProviderFetchResult,
  resolveProviderProxyUrl,
  __setTlsFetchOverrideForTesting,
  testOverride,
  isCloudflareChallenge,
  looksLikeSse,
} from "./wreqTlsBase.ts";

const PPLX_PROFILE = "firefox_148"; // matches the Firefox 148 UA we send
const PPLX_HOST = "https://www.perplexity.ai";

const DEFAULT_TIMEOUT_MS =
  Number.parseInt(process.env.OMNIROUTE_PPLX_TLS_TIMEOUT_MS || "", 10) || 30_000;

// Re-export for consumers.
export { TlsClientHangError, TlsClientUnavailableError, isCloudflareChallenge, looksLikeSse };
export { __setTlsFetchOverrideForTesting };

/**
 * Make a single HTTP request to perplexity.ai with a Firefox 148 TLS fingerprint.
 *
 * Throws TlsClientUnavailableError if wreq-js failed to load.
 */
export async function tlsFetchPerplexity(
  url: string,
  options: TlsFetchOptions = {},
): Promise<TlsFetchResult> {
  if (testOverride) return testOverride(url, options);

  const session = await getWreqSession({
    profile: PPLX_PROFILE,
    os: "macos",
    timeout: DEFAULT_TIMEOUT_MS,
    proxy: resolveProviderProxyUrl(
      PPLX_HOST,
      options.proxyUrl,
      resolveProxyForRequest,
    ),
  });

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
    PPLX_HOST,
    PPLX_PROFILE,
  );
}

import { resolveProxyForRequest } from "../utils/proxyFetch.ts";
