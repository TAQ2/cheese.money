import { describe, expect, it } from "vite-plus/test";

import { PrimaryEnvironmentRequestError, retryTransientBootstrap } from "./auth";

describe("retryTransientBootstrap", () => {
  it("waits out a request that never reached the local server", async () => {
    // A fetch that cannot connect surfaces as a TypeError. The budget now
    // starts at this first failure rather than at the first attempt, so a
    // cold start whose first attempt itself ran long — the local server's
    // first token exchange has been measured at 15 to 39 seconds — still
    // gets its retries instead of going straight to the error screen.
    let attempts = 0;
    const result = await retryTransientBootstrap(async () => {
      attempts += 1;
      if (attempts < 3) throw new TypeError("Failed to fetch");
      return "session";
    });

    expect(result).toBe("session");
    expect(attempts).toBe(3);
  });

  it("does not wait out a failure that reached the server and was rejected", async () => {
    // A genuine server 500 is not a cold start, and retrying it for fifteen
    // seconds behind a blank window only delays the message.
    const failure = new PrimaryEnvironmentRequestError({
      operation: "fetch-session-state",
      status: 500,
      cause: new Error("boom"),
    });

    let attempts = 0;
    await expect(
      retryTransientBootstrap(async () => {
        attempts += 1;
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(attempts).toBe(1);
  });

  it("treats an error carrying no HTTP status as fatal unless it is a transport failure", async () => {
    // The trap this guards: "no status could be read" is far too broad a
    // definition of transient. An encoding fault, a schema mismatch between
    // renderer and server, or a plain programming error all lack a status,
    // and none of them improves by being retried.
    const failure = PrimaryEnvironmentRequestError.fromCause({
      operation: "fetch-session-state",
      cause: new Error("renderer and server disagree about the response shape"),
    });

    expect(failure.transport).toBeUndefined();
    expect(failure.status).toBe(500);

    let attempts = 0;
    await expect(
      retryTransientBootstrap(async () => {
        attempts += 1;
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(attempts).toBe(1);
  });
});
