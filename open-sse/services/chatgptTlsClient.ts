/**
 * Browser-TLS-impersonating HTTP client for chatgpt.com.
 *
 * Why this exists: ChatGPT's Cloudflare config pins `cf_clearance` to the
 * client's TLS fingerprint (JA3/JA4) + HTTP/2 SETTINGS frame ordering.
 * Node's Undici fetch presents an obvious "not a browser" handshake and gets
 * challenged with `cf-mitigated: challenge` — even with all the right cookies.
 * This module wraps `wreq-js` (native Rust bindings with Firefox TLS profiles)
 * to send a Firefox 148 handshake instead.
 *
 * Unlike the old `tls-client-node`-based implementation, wreq-js ships its
 * Linux native binary in the npm package — no runtime GitHub API download.
 *
 * Mirrors `perplexityTlsClient.ts`; kept as an independent module so changes
 * here cannot regress the production perplexity-web path.
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

const CHATGPT_PROFILE = "firefox_148"; // matches the Firefox 148 UA we send
const CHATGPT_HOST = "https://chatgpt.com";

export { TlsClientHangError, TlsClientUnavailableError };

export interface TlsFetchOptions extends ProviderFetchOptions {
  /**
   * If true, instructs the underlying client to return the response body
   * as a base64 `data:<mime>;base64,...` string (so binary payloads survive
   * the JSON marshalling step). Required for image / binary downloads.
   */
  byteResponse?: boolean;
}

export interface TlsFetchResult extends ProviderFetchResult {}

// Test-only injection point — re-exported from wreqTlsBase.
export { __setTlsFetchOverrideForTesting };

/**
 * Test-only: expose streaming helper for unit tests.
 * Mirrors the old __tlsFetchStreamingForTesting signature but uses wreq-js.
 */
export async function __tlsFetchStreamingForTesting(
  _client: unknown,
  url: string,
  wreqOptions: Record<string, unknown>,
  options: TlsFetchOptions,
): Promise<TlsFetchResult> {
  const session = await getWreqSession({
    profile: CHATGPT_PROFILE,
    os: "macos",
    timeout: (options.timeoutMs ?? 60_000) + 10_000,
    proxy: resolveProviderProxyUrl(
      CHATGPT_HOST,
      options.proxyUrl,
      resolveProxyForRequest,
    ),
  });
  return providerFetch(session, url, wreqOptions, CHATGPT_HOST, CHATGPT_PROFILE);
}

/**
 * Make a single HTTP request to chatgpt.com with a Firefox 148 TLS fingerprint.
 *
 * Throws TlsClientUnavailableError if wreq-js failed to load.
 */
export async function tlsFetchChatGpt(
  url: string,
  options: TlsFetchOptions = {},
): Promise<TlsFetchResult> {
  if (testOverride) return testOverride(url, options);

  if (options.signal?.aborted) {
    throw makeAbortError(options.signal);
  }

  const session = await getWreqSession({
    profile: CHATGPT_PROFILE,
    os: "macos",
    timeout: options.timeoutMs ?? 60_000,
    proxy: resolveProviderProxyUrl(
      CHATGPT_HOST,
      options.proxyUrl,
      resolveProxyForRequest,
    ),
  });

  if (options.signal?.aborted) {
    throw makeAbortError(options.signal);
  }

  const timeoutMs = options.timeoutMs ?? 60_000;
  const headers = options.headers || {};

  // Build request options, including byteResponse if needed.
  const fetchOptions: ProviderFetchOptions = {
    method: options.method || "GET",
    headers,
    body: options.body,
    timeoutMs,
    signal: options.signal ?? null,
    stream: options.stream || false,
    streamEofSymbol: options.streamEofSymbol,
    proxyUrl: options.proxyUrl,
    binaryResponse: options.byteResponse === true,
  };

  return await providerFetch(session, url, fetchOptions, CHATGPT_HOST, CHATGPT_PROFILE);
}

import { resolveProxyForRequest } from "../utils/proxyFetch.ts";
