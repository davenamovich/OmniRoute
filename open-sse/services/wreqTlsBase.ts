/**
 * Shared wreq-js TLS client base for web-provider transports.
 *
 * Replaces tls-client-node for chatgpt-web, claude-web, grok-web, and perplexity-web.
 * wreq-js ships its native binary in the npm package (via optionalDependencies),
 * so there is no runtime GitHub API download and no unauthenticated rate-limit risk.
 */

import { createSession, type Session } from "wreq-js";
import { resolveProxyForRequest } from "../utils/proxyFetch.ts";

export class TlsClientHangError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TlsClientHangError";
  }
}

export class TlsClientUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TlsClientUnavailableError";
  }
}

/**
 * Resolve proxy URL for a given provider host.
 */
export function resolveProviderProxyUrl(
  providerHost: string,
  perCall: string | undefined,
  resolveProxy: typeof resolveProxyForRequest,
): string | undefined {
  return resolveTlsClientProxyUrl(providerHost, perCall, resolveProxy);
}

import { resolveTlsClientProxyUrl } from "./tlsClientProxy.ts";

/**
 * Latency grace period added to the configured timeout before our JS-level
 * hard timeout fires. Under healthy operation wreq-js honors `timeout` and
 * rejects on its own; the JS-level race only wins when the native engine
 * itself deadlocks.
 */
export function hardTimeoutMs(
  configured: number | undefined,
  envKey: string,
  defaultMs: number,
  graceEnvKey: string,
  graceDefaultMs: number,
): number {
  const configuredMs = configured ?? defaultMs;
  const graceMs = Number.parseInt(process.env[graceEnvKey] || "", 10) || graceDefaultMs;
  return configuredMs + graceMs;
}

/**
 * Create a wreq-js session with the given browser profile.
 * Singleton-per-process: the first call creates the session, subsequent calls
 * return the same promise. Calling `resetSessionCache()` drops the cache so
 * the next call respawns a fresh session.
 */
export function getWreqSession({
  profile,
  os = "macos",
  timeout = 30_000,
  proxy,
}: {
  profile: string;
  os?: string;
  timeout?: number;
  proxy?: string;
}): Promise<Session> {
  if (!getWreqSession._promise) {
    getWreqSession._promise = (async () => {
      try {
        const session = await createSession({
          browser: profile,
          os,
          timeout,
          ...(proxy ? { proxy } : {}),
        });
        installExitHook(getWreqSession._promise);
        return session;
      } catch (err) {
        getWreqSession._promise = null;
        const msg = err instanceof Error ? err.message : String(err);
        throw new TlsClientUnavailableError(
          `TLS impersonation client failed to start: ${msg}. Verify wreq-js is installed.`,
        );
      }
    })();
  }
  return getWreqSession._promise;
}

let exitHookInstalled = false;

function installExitHook(sessionPromise: Promise<Session>): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const stop = async () => {
    try {
      const s = await sessionPromise;
      await s.close?.();
    } catch {
      // ignore
    }
  };
  process.once("beforeExit", stop);
  process.once("SIGINT", () => {
    void stop();
  });
  process.once("SIGTERM", () => {
    void stop();
  });
}

/**
 * Drop the cached session so the next `getWreqSession()` call respawns it.
 */
export function resetSessionCache(): void {
  getWreqSession._promise = null;
}

getWreqSession._promise = null;

/**
 * Race a promise against a JS-level hard timeout and the caller's abort signal.
 */
export async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | null | undefined,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let abortListener: (() => void) | null = null;
  try {
    const racers: Promise<T>[] = [
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new TlsClientHangError(
              `wreq-js call exceeded ${timeoutMs}ms — likely deadlocked`,
            ),
          );
        }, timeoutMs);
      }),
    ];
    if (signal) {
      racers.push(
        new Promise<T>((_, reject) => {
          if (signal.aborted) {
            reject(makeAbortError(signal));
            return;
          }
          abortListener = () => reject(makeAbortError(signal));
          signal.addEventListener("abort", abortListener, { once: true });
        }),
      );
    }
    return await Promise.race(racers);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && abortListener)
      signal.removeEventListener("abort", abortListener);
  }
}

function makeAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(
    typeof reason === "string" ? reason : "The operation was aborted",
  );
  err.name = "AbortError";
  return err;
}

/**
 * Peek up to `n` bytes from the start of a ReadableStream.
 * Returns the peeked text and a new stream with the remaining bytes.
 */
export async function peekFirstBytes(
  stream: ReadableStream<Uint8Array>,
  n: number,
): Promise<{ peeked: string; rest: ReadableStream<Uint8Array> }> {
  const [peekSide, restSide] = stream.tee();
  const reader = peekSide.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < n) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } finally {
    reader.releaseLock();
    peekSide.cancel().catch(() => {});
  }
  const peeked = Buffer.concat(chunks).toString("utf8");
  return { peeked, rest: restSide };
}

/**
 * Read all remaining bytes from a ReadableStream into a string.
 */
export async function readAllFromStream(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Returns true if the peeked response body looks like an SSE stream.
 */
export function looksLikeSse(text: string): boolean {
  const trimmed = text.replace(/^[\s\r\n]+/, "");
  if (!trimmed) return false;
  if (trimmed.startsWith(":")) return true;
  return /^(data|event|id|retry):/i.test(trimmed);
}

/**
 * Returns true if the response body is a Cloudflare challenge/interstitial page.
 */
export function isCloudflareChallenge(
  text: string | null | undefined,
): boolean {
  if (!text) return false;
  return /just a moment|window\._cf_chl_opt|challenges\.cloudflare\.com|attention required|cf-chl/i.test(
    text,
  );
}

/**
 * Options for the provider fetch functions.
 */
export interface ProviderFetchOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal | null;
  /**
   * If true, the response body is streamed as a ReadableStream<Uint8Array>.
   */
  stream?: boolean;
  /**
   * EOF marker the upstream sends to signal end of stream (default: "[DONE]").
   */
  streamEofSymbol?: string;
  /**
   * Optional upstream proxy URL.
   */
  proxyUrl?: string;
  /**
   * If true, the response body is returned as a base64 string (for binary data).
   * The text field will contain a `data:<mime>;base64,...` URI.
   */
  binaryResponse?: boolean;
}

/**
 * Result of a provider fetch.
 */
export interface ProviderFetchResult {
  status: number;
  headers: Headers;
  /** Full response body as text — only populated for non-streaming requests. */
  text: string | null;
  /** Streaming body — only populated when options.stream === true. */
  body: ReadableStream<Uint8Array> | null;
}

/**
 * Fetch a URL with a wreq-js session, returning a ProviderFetchResult.
 * For non-streaming requests, the full body is read into memory.
 */
export async function providerFetch(
  session: Session,
  url: string,
  options: ProviderFetchOptions,
  providerHost: string,
  profile: string,
): Promise<ProviderFetchResult> {
  const timeout = hardTimeoutMs(
    options.timeoutMs,
    "OMNIROUTE_TLS_TIMEOUT_MS",
    30_000,
    "OMNIROUTE_TLS_GRACE_MS",
    10_000,
  );

  if (options.signal?.aborted) {
    throw makeAbortError(options.signal);
  }

  const wreqOptions: Record<string, unknown> = {
    method: options.method || "GET",
    headers: options.headers || {},
    body: options.body,
    timeout,
    redirect: "follow",
  };

  if (options.proxyUrl) {
    wreqOptions.proxy = options.proxyUrl;
  }
  if (options.signal) {
    wreqOptions.signal = options.signal;
  }

  if (options.stream) {
    return await providerFetchStreaming(session, url, wreqOptions, options);
  }

  let response: Response;
  try {
    response = await raceWithTimeout(
      session.fetch(url, wreqOptions),
      timeout,
      options.signal ?? null,
    );
  } catch (err) {
    if (err instanceof TlsClientHangError) {
      resetSessionCache();
    }
    throw err;
  }

  if (options.signal?.aborted) {
    throw makeAbortError(options.signal);
  }

  if (options.binaryResponse) {
    const mime = response.headers.get("content-type") || "application/octet-stream";
    const buffer = await response.arrayBuffer();
    const base64 = bufferToBase64(buffer);
    return {
      status: response.status,
      headers: response.headers,
      text: `data:${mime};base64,${base64}`,
      body: null,
    };
  }

  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    body: null,
  };
}

/**
 * Convert an ArrayBuffer to a base64 string.
 */
function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Streaming fetch: peek at the first bytes to detect SSE, then return
 * the rest of the stream if it looks like SSE, or read the full body otherwise.
 */
async function providerFetchStreaming(
  session: Session,
  url: string,
  wreqOptions: Record<string, unknown>,
  options: ProviderFetchOptions,
): Promise<ProviderFetchResult> {
  let response: Response;
  try {
    response = await raceWithTimeout(
      session.fetch(url, wreqOptions),
      hardTimeoutMs(
        options.timeoutMs,
        "OMNIROUTE_TLS_TIMEOUT_MS",
        30_000,
        "OMNIROUTE_TLS_GRACE_MS",
        10_000,
      ),
      options.signal ?? null,
    );
  } catch (err) {
    if (err instanceof TlsClientHangError) {
      resetSessionCache();
    }
    throw err;
  }

  if (options.signal?.aborted) {
    throw makeAbortError(options.signal);
  }

  const body = response.body;
  if (!body) {
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      text,
      body: null,
    };
  }

  const { peeked, rest } = await peekFirstBytes(body, 256);
  if (!looksLikeSse(peeked)) {
    const fullText = await readAllFromStream(rest);
    const completeText = peeked + fullText;
    return {
      status: response.status,
      headers: response.headers,
      text: completeText,
      body: null,
    };
  }

  const headers = new Headers({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
  });
  return { status: 200, headers, text: null, body: rest };
}

/**
 * Test-only injection point. Replaces the real fetch with a mock.
 */
export let testOverride:
  | ((url: string, options: ProviderFetchOptions) => Promise<ProviderFetchResult>)
  | null = null;

export function __setTlsFetchOverrideForTesting(
  fn: typeof testOverride,
): void {
  testOverride = fn;
}
