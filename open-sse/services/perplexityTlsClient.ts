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
 * Unlike the old `tls-client-node`-based implementation, wreq-js ships its
 * Linux native binary in the npm package — no runtime GitHub API download, no
 * unauthenticated rate-limit risk at build or runtime.
 *
 * Mirrors `chatgptTlsClient.ts`; kept as an independent module so changes here
 * cannot regress the production chatgpt-web path. The first call lazily starts
 * a singleton wreq-js session; subsequent calls reuse it. Process exit hooks
 * close the session cleanly.
 */

import { createSession, type Session } from "wreq-js";
import { resolveProxyForRequest } from "../utils/proxyFetch.ts";
import { resolveTlsClientProxyUrl } from "./tlsClientProxy.ts";

let sessionPromise: Promise<Session> | null = null;
let exitHookInstalled = false;

const PPLX_PROFILE = "firefox_148"; // matches the Firefox 148 UA we send
const DEFAULT_TIMEOUT_MS =
  Number.parseInt(process.env.OMNIROUTE_PPLX_TLS_TIMEOUT_MS || "", 10) || 30_000;
const HARD_TIMEOUT_GRACE_MS =
  Number.parseInt(process.env.OMNIROUTE_PPLX_TLS_GRACE_MS || "", 10) || 10_000;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const stop = async () => {
    if (!sessionPromise) return;
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
 * Drop the cached session so the next `getSession()` call respawns it.
 */
function resetSessionCache(): void {
  sessionPromise = null;
}

/**
 * Race a promise against a JS-level hard timeout and the caller's abort signal.
 */
async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | null | undefined
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
              `wreq-js call exceeded ${timeoutMs}ms — likely deadlocked`
            )
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
        })
      );
    }
    return await Promise.race(racers);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && abortListener)
      signal.removeEventListener("abort", abortListener);
  }
}

async function getSession(): Promise<Session> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      try {
        const proxy = resolveProxyUrl(undefined);
        const session = await createSession({
          browser: PPLX_PROFILE,
          os: "macos",
          timeout: DEFAULT_TIMEOUT_MS,
          ...(proxy ? { proxy } : {}),
        });
        installExitHook();
        return session;
      } catch (err) {
        sessionPromise = null;
        const msg = err instanceof Error ? err.message : String(err);
        throw new TlsClientUnavailableError(
          `TLS impersonation client failed to start: ${msg}. ` +
            `Verify wreq-js is installed.`
        );
      }
    })();
  }
  return sessionPromise;
}

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

function resolveProxyUrl(perCall: string | undefined): string | undefined {
  return resolveTlsClientProxyUrl(
    "https://www.perplexity.ai",
    perCall,
    resolveProxyForRequest,
  );
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
 * Returns true if the response body is a Cloudflare challenge/interstitial page
 * rather than a real Perplexity response. (issue #2459)
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
 * Returns true if the peeked response body looks like an SSE stream — i.e.,
 * begins (after any leading whitespace) with one of the SSE field markers
 * (`data:`, `event:`, `id:`, `retry:`) or a comment line (`:`).
 *
 * Exported for tests.
 */
export function looksLikeSse(text: string): boolean {
  const trimmed = text.replace(/^[\s\r\n]+/, "");
  if (!trimmed) return false;
  if (trimmed.startsWith(":")) return true;
  return /^(data|event|id|retry):/i.test(trimmed);
}

/**
 * Options for tlsFetchPerplexity.
 */
export interface TlsFetchOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal | null;
  /**
   * If true, the response body is streamed as a ReadableStream<Uint8Array>.
   * Use for SSE responses (the perplexity_ask endpoint).
   * wreq-js streams natively — no temp file needed.
   */
  stream?: boolean;
  /**
   * EOF marker the upstream sends to signal end of stream (default: "[DONE]").
   */
  streamEofSymbol?: string;
  /**
   * Optional upstream proxy URL (http://user:pass@host:port or socks5://...).
   * When set, the request is tunneled through this proxy before reaching
   * perplexity.ai.
   *
   * Resolution order:
   *   1. options.proxyUrl (per-call override from caller)
   *   2. process.env.OMNIROUTE_TLS_PROXY_URL (single-flag opt-in)
   *   3. process.env.HTTPS_PROXY / HTTP_PROXY / ALL_PROXY (POSIX-standard fallback)
   *
   * wreq-js natively supports proxy at the session and per-request level.
   */
  proxyUrl?: string;
}

export interface TlsFetchResult {
  status: number;
  headers: Headers;
  /** Full response body as text — only populated for non-streaming requests. */
  text: string | null;
  /** Streaming body — only populated when options.stream === true. */
  body: ReadableStream<Uint8Array> | null;
}

// Test-only injection point. Tests call __setTlsFetchOverrideForTesting()
// to replace the real TLS client with a mock; production never touches this.
let testOverride: ((url: string, options: TlsFetchOptions) => Promise<TlsFetchResult>) | null =
  null;

export function __setTlsFetchOverrideForTesting(fn: typeof testOverride): void {
  testOverride = fn;
}

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

  // Honor abort signals up-front.
  if (options.signal?.aborted) {
    throw makeAbortError(options.signal);
  }

  const session = await getSession();
  if (options.signal?.aborted) {
    throw makeAbortError(options.signal);
  }

  const timeoutMs = (options.timeoutMs ?? DEFAULT_TIMEOUT_MS) + HARD_TIMEOUT_GRACE_MS;

  const wreqOptions: Record<string, unknown> = {
    method: options.method || "GET",
    headers: options.headers || {},
    body: options.body,
    timeout: timeoutMs,
    redirect: "follow",
  };

  // Per-request proxy override (session-level proxy is set at creation time).
  if (options.proxyUrl) {
    wreqOptions.proxy = options.proxyUrl;
  }

  if (options.signal) {
    wreqOptions.signal = options.signal;
  }

  if (options.stream) {
    return await tlsFetchStreaming(session, url, wreqOptions, options);
  }

  let response: Response;
  try {
    response = await raceWithTimeout(
      session.fetch(url, wreqOptions),
      timeoutMs,
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

  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    body: null,
  };
}

/**
 * Streaming fetch via wreq-js's native ReadableStream.
 * wreq-js responses expose a standards-compliant body stream.
 *
 * To peek at the first bytes and determine if the response is SSE, we tee
 * the stream: one side is consumed for the peek, the other is returned to
 * the caller as the streaming body.
 */
async function tlsFetchStreaming(
  session: Session,
  url: string,
  wreqOptions: Record<string, unknown>,
  options: TlsFetchOptions,
): Promise<TlsFetchResult> {
  let response: Response;
  try {
    response = await raceWithTimeout(
      session.fetch(url, wreqOptions),
      (options.timeoutMs ?? DEFAULT_TIMEOUT_MS) + HARD_TIMEOUT_GRACE_MS,
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

  // Peek the first bytes to decide whether this looks like SSE.
  const { peeked, rest } = await peekFirstBytes(body, 256);
  if (!looksLikeSse(peeked)) {
    // Re-read the full body from the rest stream (plus the peeked bytes).
    const fullText = await readAllFromStream(rest);
    const completeText = peeked + fullText;
    return {
      status: response.status,
      headers: response.headers,
      text: completeText,
      body: null,
    };
  }

  // Looks like SSE — return the rest stream.
  const headers = new Headers({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
  });
  return { status: 200, headers, text: null, body: rest };
}

/**
 * Peek up to `n` bytes from the start of a ReadableStream.
 * Returns the peeked text and a new stream with the remaining bytes.
 *
 * Uses tee() so reading from the peek side doesn't consume from the rest side.
 */
async function peekFirstBytes(
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
async function readAllFromStream(
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
 * Test-only: expose streaming helper for unit tests.
 */
export async function __tlsFetchStreamingForTesting(
  session: Session,
  url: string,
  wreqOptions: Record<string, unknown>,
  options: TlsFetchOptions,
): Promise<TlsFetchResult> {
  return tlsFetchStreaming(session, url, wreqOptions, options);
}
