import { describe, expect, it } from "@effect/vitest";

import {
  synthesizeWithEdgeTts,
  buildSpeechConfigMessage,
  buildSsmlMessage,
  escapeSsmlText,
  javascriptStyleTimestamp,
  parseAudioFrame,
  secMsGecToken,
} from "./EdgeTtsClient.ts";

describe("secMsGecToken", () => {
  // Pinned against the reference `edge-tts` implementation, computed with the
  // same fixed timestamps. A drift here means the hashing arithmetic no longer
  // matches the scheme the service checks.
  it("matches the reference implementation", () => {
    expect(secMsGecToken(1754448000000)).toBe(
      "7E63B2DA10B480B86E790914F83FF7B6627E08E1784D40199493B5FB9FB44C7E",
    );
    expect(secMsGecToken(1700000000500)).toBe(
      "42301B335578FEFDAE2637DED1ABD614505D432559EC08032B82048483726AFF",
    );
  });

  it("is stable within one five-minute bucket and changes across buckets", () => {
    const bucketStart = 1754448000000;
    expect(secMsGecToken(bucketStart)).toBe(secMsGecToken(bucketStart + 299_000));
    expect(secMsGecToken(bucketStart)).not.toBe(secMsGecToken(bucketStart + 300_000));
  });
});

describe("escapeSsmlText", () => {
  it("escapes every XML-special character", () => {
    expect(escapeSsmlText(`a & b < c > d ' e " f`)).toBe(
      "a &amp; b &lt; c &gt; d &apos; e &quot; f",
    );
  });

  it("cannot be broken out of with a crafted closing tag", () => {
    expect(escapeSsmlText("</prosody><voice name='x'>")).not.toContain("<");
  });
});

describe("javascriptStyleTimestamp", () => {
  it("formats the service's expected shape from UTC parts", () => {
    // @effect-diagnostics-next-line globalDate:off
    expect(javascriptStyleTimestamp(new Date(Date.UTC(2026, 7, 6, 3, 5, 9)))).toBe(
      "Thu Aug 06 2026 03:05:09 GMT+0000 (Coordinated Universal Time)",
    );
  });
});

describe("message builders", () => {
  it("builds the speech.config message with CRLF headers", () => {
    const message = buildSpeechConfigMessage("STAMP");
    expect(message.startsWith("X-Timestamp:STAMP\r\n")).toBe(true);
    expect(message).toContain("Path:speech.config\r\n\r\n");
    expect(message).toContain('"outputFormat":"audio-24khz-48kbitrate-mono-mp3"');
  });

  it("builds the ssml message carrying voice, rate and text", () => {
    const message = buildSsmlMessage({
      requestId: "abc123",
      timestamp: "STAMP",
      voice: "es-MX-JorgeNeural",
      rate: "+0%",
      escapedText: "Hola",
    });
    expect(message).toContain("X-RequestId:abc123\r\n");
    expect(message).toContain("X-Timestamp:STAMPZ\r\n");
    expect(message).toContain("<voice name='es-MX-JorgeNeural'>");
    expect(message).toContain("rate='+0%'");
    expect(message).toContain(">Hola</prosody>");
  });
});

describe("parseAudioFrame", () => {
  const frame = (header: string, payload: Uint8Array): Uint8Array => {
    const headerBytes = new TextEncoder().encode(header);
    const out = new Uint8Array(2 + headerBytes.length + payload.length);
    out[0] = headerBytes.length >> 8;
    out[1] = headerBytes.length & 0xff;
    out.set(headerBytes, 2);
    out.set(payload, 2 + headerBytes.length);
    return out;
  };

  it("returns the payload of an audio frame", () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const parsed = parseAudioFrame(frame("X-RequestId:x\r\nPath:audio", payload));
    expect(parsed).toEqual(payload);
  });

  it("ignores frames on other paths, even ones mentioning audio elsewhere", () => {
    expect(parseAudioFrame(frame("Path:audio.metadata", new Uint8Array([9])))).toBeUndefined();
    expect(
      parseAudioFrame(frame("X-Path:audio\r\nPath:other", new Uint8Array([9]))),
    ).toBeUndefined();
  });

  it("rejects truncated frames instead of reading out of bounds", () => {
    expect(parseAudioFrame(new Uint8Array([]))).toBeUndefined();
    expect(parseAudioFrame(new Uint8Array([0]))).toBeUndefined();
    expect(parseAudioFrame(new Uint8Array([0xff, 0xff, 65]))).toBeUndefined();
  });
});

/**
 * A scripted stand-in for the runtime's websocket client, so the promise
 * lifecycle — settle-once, abort, close-before-end, listener errors — can be
 * driven without a network.
 */
class FakeSocket {
  static instances: Array<FakeSocket> = [];
  static onConstruct: ((socket: FakeSocket) => void) | undefined;
  binaryType = "blob";
  closed = 0;
  sent: Array<string> = [];
  sendError: Error | undefined;
  private listeners = new Map<string, Array<(event: object) => void>>();
  constructor() {
    FakeSocket.instances.push(this);
    FakeSocket.onConstruct?.(this);
  }
  addEventListener(type: string, listener: (event: object) => void) {
    const existing = this.listeners.get(type) ?? [];
    this.listeners.set(type, [...existing, listener]);
  }
  send(data: string) {
    if (this.sendError) throw this.sendError;
    this.sent.push(data);
  }
  close() {
    this.closed += 1;
  }
  emit(type: string, event: object = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  emitAudio(payload: Uint8Array) {
    const header = new TextEncoder().encode("Path:audio");
    const frame = new Uint8Array(2 + header.length + payload.length);
    frame[0] = header.length >> 8;
    frame[1] = header.length & 0xff;
    frame.set(header, 2);
    frame.set(payload, 2 + header.length);
    this.emit("message", { data: frame.buffer.slice(0, frame.length) });
  }
}

describe("synthesizeWithEdgeTts lifecycle", () => {
  const globalScope = globalThis as Record<string, unknown>;
  const input = { text: "Hello", voice: "en-GB-RyanNeural", rate: "+0%", nowMs: 1754448000000 };

  const withFakeSocket = async <T>(run: () => Promise<T>): Promise<T> => {
    const previous = globalScope["WebSocket"];
    globalScope["WebSocket"] = FakeSocket;
    FakeSocket.instances = [];
    try {
      return await run();
    } finally {
      globalScope["WebSocket"] = previous;
      FakeSocket.onConstruct = undefined;
    }
  };

  it("resolves with the concatenated audio and closes the socket once", async () =>
    withFakeSocket(async () => {
      const pending = synthesizeWithEdgeTts(input);
      const socket = FakeSocket.instances[0]!;
      socket.emit("open");
      socket.emitAudio(new Uint8Array([1, 2]));
      socket.emitAudio(new Uint8Array([3]));
      socket.emit("message", { data: "Path:turn.end\r\n\r\n" });
      // The close that follows a settled promise must not flip it to an error.
      socket.emit("close", { code: 1000 });
      await expect(pending).resolves.toEqual(new Uint8Array([1, 2, 3]));
      expect(socket.closed).toBe(1);
      expect(socket.sent).toHaveLength(2);
    }));

  it("rejects when the connection closes before the turn ends", async () =>
    withFakeSocket(async () => {
      const pending = synthesizeWithEdgeTts(input);
      const socket = FakeSocket.instances[0]!;
      socket.emit("open");
      socket.emit("close", { code: 1006 });
      await expect(pending).rejects.toThrow(/closed the connection/);
    }));

  it("rejects on turn.end with no audio instead of resolving empty", async () =>
    withFakeSocket(async () => {
      const pending = synthesizeWithEdgeTts(input);
      const socket = FakeSocket.instances[0]!;
      socket.emit("open");
      socket.emit("message", { data: "Path:turn.end\r\n\r\n" });
      await expect(pending).rejects.toThrow(/no audio/);
    }));

  it("settles instead of throwing when sending the request fails", async () =>
    withFakeSocket(async () => {
      FakeSocket.onConstruct = (socket) => {
        socket.sendError = new Error("socket not ready");
      };
      const pending = synthesizeWithEdgeTts(input);
      const socket = FakeSocket.instances[0]!;
      socket.emit("open");
      await expect(pending).rejects.toThrow(/Could not send the synthesis request/);
      expect(socket.closed).toBe(1);
    }));

  it("rejects and closes on abort, discarding a late turn.end", async () =>
    withFakeSocket(async () => {
      const controller = new AbortController();
      const pending = synthesizeWithEdgeTts({ ...input, signal: controller.signal });
      const socket = FakeSocket.instances[0]!;
      socket.emit("open");
      controller.abort();
      socket.emitAudio(new Uint8Array([9]));
      socket.emit("message", { data: "Path:turn.end\r\n\r\n" });
      await expect(pending).rejects.toThrow(/cancelled/);
      expect(socket.closed).toBe(1);
    }));

  it("accepts binary frames delivered as views, not only ArrayBuffer", async () =>
    withFakeSocket(async () => {
      const pending = synthesizeWithEdgeTts(input);
      const socket = FakeSocket.instances[0]!;
      socket.emit("open");
      const header = new TextEncoder().encode("Path:audio");
      const frame = new Uint8Array(2 + header.length + 1);
      frame[0] = header.length >> 8;
      frame[1] = header.length & 0xff;
      frame.set(header, 2);
      frame[2 + header.length] = 7;
      socket.emit("message", { data: frame });
      socket.emit("message", { data: "Path:turn.end\r\n\r\n" });
      await expect(pending).resolves.toEqual(new Uint8Array([7]));
    }));

  it("rejects invalid voice and rate without constructing a socket", async () =>
    withFakeSocket(async () => {
      await expect(synthesizeWithEdgeTts({ ...input, voice: "say" })).rejects.toThrow(
        /Not an engine voice id/,
      );
      await expect(synthesizeWithEdgeTts({ ...input, rate: "BOGUS" })).rejects.toThrow(
        /Not a rate adjustment/,
      );
      expect(FakeSocket.instances).toHaveLength(0);
    }));
});
