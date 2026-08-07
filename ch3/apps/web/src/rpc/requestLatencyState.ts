import { useAtomValue } from "@effect/atom-react";
import { WS_METHODS } from "@ch3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "./atomRegistry";

/**
 * How long a request may go unacknowledged before the "Some requests are slow"
 * toast appears.
 *
 * 15 seconds, for every request EXCEPT the ones excused by name below.
 * Raising this globally to accommodate one legitimately slow feature was
 * wrong: it blinded the connection-health signal for everything else, on
 * exactly the unfamiliar networks where it matters most.
 */
export const SLOW_RPC_ACK_THRESHOLD_MS = 15_000;
export const MAX_TRACKED_RPC_ACK_REQUESTS = 256;
let slowRpcAckThresholdMs = SLOW_RPC_ACK_THRESHOLD_MS;

export interface SlowRpcAckRequest {
  readonly requestId: string;
  readonly startedAt: string;
  readonly startedAtMs: number;
  readonly tag: string;
  readonly thresholdMs: number;
}

interface PendingRpcAckRequest {
  readonly request: SlowRpcAckRequest;
  readonly timeoutId: ReturnType<typeof setTimeout>;
}

const pendingRpcAckRequests = new Map<string, PendingRpcAckRequest>();
const untrackedRpcAckTags = new Set<string>([
  WS_METHODS.previewAutomationConnect,
  // Speech synthesis legitimately runs from tens of seconds to minutes; a
  // slow clip is not a sick connection, and its own spinner already says so.
  WS_METHODS.speechSynthesize,
  // A sign-in waits for a person to finish a browser flow — up to five
  // minutes by design, never a connection problem.
  WS_METHODS.claudeStartAccountLogin,
  WS_METHODS.claudeAwaitAccountLogin,
]);

const slowRpcAckRequestsAtom = Atom.make<ReadonlyArray<SlowRpcAckRequest>>([]).pipe(
  Atom.keepAlive,
  Atom.withLabel("slow-rpc-ack-requests"),
);

function setSlowRpcAckRequests(requests: ReadonlyArray<SlowRpcAckRequest>) {
  appAtomRegistry.set(slowRpcAckRequestsAtom, [...requests]);
}

function getSlowRpcAckRequestsValue(): ReadonlyArray<SlowRpcAckRequest> {
  return appAtomRegistry.get(slowRpcAckRequestsAtom);
}

function shouldTrackRpcAck(tag: string): boolean {
  if (tag.includes("subscribe")) return false;
  // Tags arrive as "method · environmentId"; the exemption list holds bare
  // method names. Matching the whole tag against the set silently exempts
  // NOTHING — which is how the speech exemption shipped dead the first time.
  const method = tag.split(" · ")[0] ?? tag;
  return !untrackedRpcAckTags.has(method);
}

export function getSlowRpcAckRequests(): ReadonlyArray<SlowRpcAckRequest> {
  return getSlowRpcAckRequestsValue();
}

export function trackRpcRequestSent(requestId: string, tag: string): void {
  if (!shouldTrackRpcAck(tag)) {
    return;
  }

  clearTrackedRpcRequest(requestId);
  evictOldestPendingRpcRequestIfNeeded();

  const startedAtMs = Date.now();
  const request: SlowRpcAckRequest = {
    requestId,
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    tag,
    thresholdMs: slowRpcAckThresholdMs,
  };
  const timeoutId = setTimeout(() => {
    pendingRpcAckRequests.delete(requestId);
    appendSlowRpcAckRequest(request);
  }, slowRpcAckThresholdMs);

  pendingRpcAckRequests.set(requestId, {
    request,
    timeoutId,
  });
}

export function acknowledgeRpcRequest(requestId: string): void {
  clearTrackedRpcRequest(requestId);
  const slowRequests = getSlowRpcAckRequestsValue();
  if (!slowRequests.some((request) => request.requestId === requestId)) {
    return;
  }

  setSlowRpcAckRequests(slowRequests.filter((request) => request.requestId !== requestId));
}

export function clearAllTrackedRpcRequests(): void {
  for (const pending of pendingRpcAckRequests.values()) {
    clearTimeout(pending.timeoutId);
  }
  pendingRpcAckRequests.clear();
  setSlowRpcAckRequests([]);
}

function clearTrackedRpcRequest(requestId: string): void {
  const pending = pendingRpcAckRequests.get(requestId);
  if (!pending) {
    return;
  }

  clearTimeout(pending.timeoutId);
  pendingRpcAckRequests.delete(requestId);
}

function appendSlowRpcAckRequest(request: SlowRpcAckRequest): void {
  const requests = [...getSlowRpcAckRequestsValue(), request];
  if (requests.length <= MAX_TRACKED_RPC_ACK_REQUESTS) {
    setSlowRpcAckRequests(requests);
    return;
  }

  setSlowRpcAckRequests(requests.slice(-MAX_TRACKED_RPC_ACK_REQUESTS));
}

function evictOldestPendingRpcRequestIfNeeded(): void {
  while (pendingRpcAckRequests.size >= MAX_TRACKED_RPC_ACK_REQUESTS) {
    const oldestRequestId = pendingRpcAckRequests.keys().next().value;
    if (oldestRequestId === undefined) {
      return;
    }

    clearTrackedRpcRequest(oldestRequestId);
  }
}

export function resetRequestLatencyStateForTests(): void {
  slowRpcAckThresholdMs = SLOW_RPC_ACK_THRESHOLD_MS;
  clearAllTrackedRpcRequests();
}

export function setSlowRpcAckThresholdMsForTests(thresholdMs: number): void {
  slowRpcAckThresholdMs = thresholdMs;
}

export function useSlowRpcAckRequests(): ReadonlyArray<SlowRpcAckRequest> {
  return useAtomValue(slowRpcAckRequestsAtom);
}
