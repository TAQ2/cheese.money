// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

/**
 * A native client for Microsoft's Edge text-to-speech service — the same
 * service `edge-tts` wraps, spoken directly over a websocket from this server.
 *
 * Native rather than an external engine, for two reasons. Self-containment:
 * the old path needed a cloned Python project, its virtual environment and a
 * package inside it, all at an exact location on the machine running the
 * server — any piece missing and the capability silently vanished. And
 * safety: that wrapper fell back to reading the text aloud through the HOST'S
 * OWN speakers when synthesis failed, a path that could not be closed from
 * this repo. This client has no such fallback to reach — a failure is an
 * error, never sound in a room nobody is in.
 *
 * The cost accepted in exchange: the service's anti-abuse token scheme is
 * Microsoft's to change, and when they rotate it this file is ours to fix.
 * Everything protocol-shaped below mirrors the `edge-tts` implementation,
 * which is the community's record of the current scheme.
 */

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
/** The Edge build this client claims to be; travels in the token version and user agent. */
const CHROMIUM_FULL_VERSION = "143.0.3650.75";
const CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split(".")[0] ?? "143";
const SYNTHESIS_URL = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
/** 48 kbps constant-bitrate mp3 — the format the cache and the client player already expect. */
const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

/**
 * Mirrors of the contract's own format checks. The RPC schema rejects bad
 * values first; these exist so a server-side caller that never crossed the
 * schema cannot put an arbitrary string into the SSML either.
 */
const VOICE_ID_PATTERN = /^[a-z]{2,3}(-[A-Za-z]+)+Neural$/;
const RATE_PATTERN = /^[+-]\d{1,3}%$/;

/**
 * The service's anti-abuse token: the current time on the Windows file-time
 * epoch, floored to a five-minute bucket, hashed with the trusted client
 * token. Derived from the system clock, so a machine whose clock is more than
 * a few minutes wrong is refused by the service — that failure surfaces as a
 * handshake rejection, not a silent one.
 */
export function secMsGecToken(nowMs: number): string {
  let ticks = nowMs / 1000 + 11644473600;
  ticks -= ticks % 300;
  ticks *= 1e9 / 100;
  return NodeCrypto.createHash("sha256")
    .update(`${ticks.toFixed(0)}${TRUSTED_CLIENT_TOKEN}`, "ascii")
    .digest("hex")
    .toUpperCase();
}

/**
 * The five XML-special characters, so reply text cannot break out of the SSML
 * body — plus removal of the control characters XML cannot represent at all,
 * which would make the whole document unparseable rather than dangerous.
 */
export function escapeSsmlText(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll("'", "&apos;")
      .replaceAll('"', "&quot;")
  );
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** The Javascript-style date string the service expects in `X-Timestamp` headers. */
export function javascriptStyleTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${WEEKDAYS[date.getUTCDay()]} ${MONTHS[date.getUTCMonth()]} ${pad(date.getUTCDate())} ` +
    `${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:` +
    `${pad(date.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`
  );
}

export function buildSpeechConfigMessage(timestamp: string): string {
  return (
    `X-Timestamp:${timestamp}\r\n` +
    `Content-Type:application/json; charset=utf-8\r\n` +
    `Path:speech.config\r\n\r\n` +
    `{"context":{"synthesis":{"audio":{"metadataoptions":{` +
    `"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},` +
    `"outputFormat":"${OUTPUT_FORMAT}"}}}}\r\n`
  );
}

export function buildSsmlMessage(input: {
  readonly requestId: string;
  readonly timestamp: string;
  readonly voice: string;
  readonly rate: string;
  readonly escapedText: string;
}): string {
  return (
    `X-RequestId:${input.requestId}\r\n` +
    `Content-Type:application/ssml+xml\r\n` +
    // The doubled-looking `Z` after a `GMT+0000 (...)` timestamp is the
    // service's own quirk, faithfully reproduced from the reference client.
    `X-Timestamp:${input.timestamp}Z\r\n` +
    `Path:ssml\r\n\r\n` +
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
    `<voice name='${input.voice}'>` +
    `<prosody pitch='+0Hz' rate='${input.rate}' volume='+0%'>` +
    `${input.escapedText}</prosody></voice></speak>`
  );
}

/**
 * Pull the audio payload out of one binary frame, or `undefined` when the
 * frame carries something else. Layout: two big-endian bytes of header
 * length, the ascii header block, then the payload.
 */
export function parseAudioFrame(frame: Uint8Array): Uint8Array | undefined {
  if (frame.length < 2) return undefined;
  const headerLength = ((frame[0] ?? 0) << 8) | (frame[1] ?? 0);
  if (frame.length < 2 + headerLength) return undefined;
  const header = new TextDecoder().decode(frame.subarray(2, 2 + headerLength));
  if (!/(?:^|\r\n)Path:audio(?:\r\n|$)/.test(header)) return undefined;
  return frame.subarray(2 + headerLength);
}

function pathOfTextFrame(data: string): string | undefined {
  return /(?:^|\r\n)Path:(\S+)/.exec(data)?.[1];
}

/**
 * The shape of the runtime's own websocket client, stated structurally
 * rather than taken from a lib type: the `headers` option is a Node
 * extension the standard constructor type does not admit, and the service
 * rejects handshakes that do not look like a browser's.
 */
interface EdgeSocket {
  binaryType: string;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: EdgeSocketEvent) => void): void;
}

interface EdgeSocketEvent {
  readonly data?: unknown;
  readonly code?: number;
  readonly reason?: string;
  readonly message?: string;
}

type EdgeSocketConstructor = new (
  url: string,
  options?: { readonly headers?: Record<string, string> },
) => EdgeSocket;

function resolveSocketConstructor(): EdgeSocketConstructor | undefined {
  const candidate = (globalThis as Record<string, unknown>)["WebSocket"];
  return typeof candidate === "function" ? (candidate as EdgeSocketConstructor) : undefined;
}

export class EdgeTtsError extends Error {
  readonly _tag = "EdgeTtsError";
}

function concatenateAudio(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const audio = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    audio.set(chunk, offset);
    offset += chunk.length;
  }
  return audio;
}

/**
 * Speak `text` with `voice`, returning the complete mp3.
 *
 * One websocket, one utterance, no retries: the caller owns timeout and
 * retry policy through the abort signal. The socket is closed on every exit
 * path, including abort, so an interrupted synthesis cannot leave a
 * connection streaming into nothing.
 */
export function synthesizeWithEdgeTts(input: {
  readonly text: string;
  readonly voice: string;
  readonly rate: string;
  /** The clock is injected by the Effect caller; this plain-Promise boundary never reads it itself. */
  readonly nowMs: number;
  readonly signal?: AbortSignal;
}): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    if (!VOICE_ID_PATTERN.test(input.voice)) {
      reject(new EdgeTtsError(`Not an engine voice id: ${input.voice}`));
      return;
    }
    if (!RATE_PATTERN.test(input.rate)) {
      reject(new EdgeTtsError(`Not a rate adjustment: ${input.rate}`));
      return;
    }
    const SocketConstructor = resolveSocketConstructor();
    if (!SocketConstructor) {
      reject(new EdgeTtsError("This runtime has no websocket client."));
      return;
    }
    if (input.signal?.aborted) {
      reject(new EdgeTtsError("Synthesis was cancelled."));
      return;
    }

    const connectionId = NodeCrypto.randomUUID().replaceAll("-", "");
    const url =
      `${SYNTHESIS_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
      `&ConnectionId=${connectionId}` +
      `&Sec-MS-GEC=${secMsGecToken(input.nowMs)}` +
      `&Sec-MS-GEC-Version=1-${CHROMIUM_FULL_VERSION}`;
    const socket = new SocketConstructor(url, {
      headers: {
        Pragma: "no-cache",
        "Cache-Control": "no-cache",
        Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
        "User-Agent":
          `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36` +
          ` (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36` +
          ` Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
        "Accept-Language": "en-US,en;q=0.9",
        Cookie: `muid=${NodeCrypto.randomBytes(16).toString("hex").toUpperCase()};`,
      },
    });
    socket.binaryType = "arraybuffer";

    const chunks: Array<Uint8Array> = [];
    let settled = false;
    const settle = (outcome: { audio: Uint8Array } | { error: Error }) => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", onAbort);
      try {
        socket.close();
      } catch {
        // A socket that cannot close any further is already what we wanted.
      }
      if ("audio" in outcome) resolve(outcome.audio);
      else reject(outcome.error);
    };
    const onAbort = () => settle({ error: new EdgeTtsError("Synthesis was cancelled.") });
    input.signal?.addEventListener("abort", onAbort);

    socket.addEventListener("open", () => {
      // A throw inside this listener would otherwise escape into the event
      // dispatch — an unhandled exception for the whole process — while the
      // promise sat unsettled behind an open socket until the caller's
      // timeout. Every failure becomes a settled rejection instead.
      try {
        // @effect-diagnostics-next-line globalDate:off
        const timestamp = javascriptStyleTimestamp(new Date(input.nowMs));
        socket.send(buildSpeechConfigMessage(timestamp));
        socket.send(
          buildSsmlMessage({
            requestId: NodeCrypto.randomUUID().replaceAll("-", ""),
            timestamp,
            voice: input.voice,
            rate: input.rate,
            escapedText: escapeSsmlText(input.text),
          }),
        );
      } catch (cause) {
        settle({
          error: new EdgeTtsError(
            `Could not send the synthesis request: ${cause instanceof Error ? cause.message : String(cause)}`,
          ),
        });
      }
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        if (pathOfTextFrame(event.data) === "turn.end") {
          const audio = concatenateAudio(chunks);
          if (audio.length === 0) {
            settle({ error: new EdgeTtsError("The speech service returned no audio.") });
            return;
          }
          settle({ audio });
        }
        return;
      }
      // The runtime's own client delivers `ArrayBuffer` (binaryType is set
      // above); views are accepted too so a runtime swap degrades to working
      // rather than to "returned no audio".
      if (event.data instanceof ArrayBuffer) {
        const payload = parseAudioFrame(new Uint8Array(event.data));
        if (payload) chunks.push(payload);
      } else if (ArrayBuffer.isView(event.data)) {
        const view = event.data;
        const payload = parseAudioFrame(
          new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
        );
        if (payload) chunks.push(payload);
      }
    });
    socket.addEventListener("error", (event) => {
      settle({
        error: new EdgeTtsError(
          `The speech service connection failed${event.message ? `: ${event.message}` : "."}`,
        ),
      });
    });
    socket.addEventListener("close", (event) => {
      settle({
        error: new EdgeTtsError(
          `The speech service closed the connection before finishing` +
            `${event.code ? ` (${event.code}${event.reason ? ` ${event.reason}` : ""})` : ""}.`,
        ),
      });
    });
  });
}
