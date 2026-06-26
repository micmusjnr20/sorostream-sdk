/**
 * In-memory mock of the SoroStream contract for consumer unit tests.
 *
 * Drop-in replacement for {@link SoroStreamClient} that requires no network
 * access. Mirrors the real contract's flow-rate math and status transitions.
 *
 * @example
 * ```ts
 * import { MockSoroStreamClient } from "@sorostream/sdk/mock";
 *
 * const mock = new MockSoroStreamClient();
 * const { streamId } = await mock.createStream({
 *   recipient: "GRECIPIENT...",
 *   token: "GUSDC...",
 *   amount: 1_000_000_000n,
 *   durationSeconds: 3600,
 *   autoRenew: false,
 * });
 * const claimable = await mock.getClaimable(streamId);
 * ```
 */

import type {
  CancelStreamParams,
  CreateStreamParams,
  PaginatedStreams,
  PaginationParams,
  Stream,
  StreamEvent,
  StreamEventFilter,
  StreamSubscription,
  TopUpParams,
  WithdrawParams,
} from "./types.js";

let nextId = 1;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function claimableAt(stream: Stream, atSec: number): bigint {
  if (stream.status !== "Active") return 0n;
  const effectiveNow = Math.min(atSec, stream.endTime);
  const elapsed = Math.max(0, effectiveNow - stream.lastWithdrawTime);
  return stream.flowRate * BigInt(elapsed);
}

type Listener = {
  filter: (e: StreamEvent) => boolean;
  callback: (e: StreamEvent) => void;
};

export class MockSoroStreamClient {
  private streams = new Map<string, Stream>();
  private listeners = new Map<string, Listener>();
  private senderKey: string;

  constructor(senderKey = "GMOCK_SENDER") {
    this.senderKey = senderKey;
  }

  /** Override the mock's current "sender" address (simulates wallet.getPublicKey). */
  setSender(address: string): void {
    this.senderKey = address;
  }

  /** Directly inject a pre-built stream — useful for testing edge cases. */
  seedStream(stream: Stream): void {
    this.streams.set(stream.id, { ...stream });
  }

  /** Advance a stream's `lastWithdrawTime` by `seconds` without going through withdraw. */
  advanceTime(streamId: string, seconds: number): void {
    const s = this.streams.get(streamId);
    if (!s) throw new Error(`Stream not found: ${streamId}`);
    const newTime = Math.min(s.lastWithdrawTime + seconds, s.endTime);
    this.streams.set(streamId, { ...s, lastWithdrawTime: newTime });
  }

  private emit(event: StreamEvent): void {
    for (const listener of this.listeners.values()) {
      if (listener.filter(event)) listener.callback(event);
    }
  }

  async createStream(
    params: CreateStreamParams
  ): Promise<{ streamId: string; txHash: string }> {
    if (params.amount <= 0n) throw new Error("Amount must be > 0");
    if (params.durationSeconds <= 0) throw new Error("Duration must be > 0");

    const id = String(nextId++);
    const now = nowSec();
    const flowRate = params.amount / BigInt(params.durationSeconds);
    const stream: Stream = {
      id,
      sender: this.senderKey,
      recipient: params.recipient,
      token: params.token,
      deposit: params.amount,
      flowRate,
      startTime: now,
      endTime: now + params.durationSeconds,
      lastWithdrawTime: now,
      status: "Active",
      autoRenew: params.autoRenew,
    };
    this.streams.set(id, stream);
    this.emit({
      type: "StreamCreated",
      streamId: id,
      txHash: `mock-tx-create-${id}`,
      ledger: 0,
      timestamp: now,
      data: { sender: stream.sender, recipient: stream.recipient },
    });
    return { streamId: id, txHash: `mock-tx-create-${id}` };
  }

  async withdraw(params: WithdrawParams): Promise<{ txHash: string; amount: string }> {
    const stream = this.streams.get(params.streamId);
    if (!stream) throw new Error(`Stream not found: ${params.streamId}`);
    if (stream.status !== "Active") throw new Error("Stream is not active");

    const now = nowSec();
    const amount = claimableAt(stream, now);
    const newLastWithdraw = Math.min(now, stream.endTime);
    const newStatus: Stream["status"] =
      newLastWithdraw >= stream.endTime ? "Completed" : "Active";

    this.streams.set(params.streamId, {
      ...stream,
      lastWithdrawTime: newLastWithdraw,
      status: newStatus,
    });

    this.emit({
      type: "StreamWithdrawn",
      streamId: params.streamId,
      txHash: `mock-tx-withdraw-${params.streamId}-${now}`,
      ledger: 0,
      timestamp: now,
      data: { amount: amount.toString() },
    });

    if (newStatus === "Completed") {
      this.emit({
        type: "StreamCompleted",
        streamId: params.streamId,
        txHash: `mock-tx-complete-${params.streamId}`,
        ledger: 0,
        timestamp: now,
        data: {},
      });
    }

    return {
      txHash: `mock-tx-withdraw-${params.streamId}-${now}`,
      amount: amount.toString(),
    };
  }

  async cancelStream(params: CancelStreamParams): Promise<{ txHash: string }> {
    const stream = this.streams.get(params.streamId);
    if (!stream) throw new Error(`Stream not found: ${params.streamId}`);
    if (stream.status !== "Active") throw new Error("Stream is not active");

    this.streams.set(params.streamId, { ...stream, status: "Cancelled" });
    const now = nowSec();
    this.emit({
      type: "StreamCancelled",
      streamId: params.streamId,
      txHash: `mock-tx-cancel-${params.streamId}`,
      ledger: 0,
      timestamp: now,
      data: {},
    });
    return { txHash: `mock-tx-cancel-${params.streamId}` };
  }

  async topUp(
    params: TopUpParams
  ): Promise<{ txHash: string; newEndTime: Date }> {
    if (params.amount <= 0n) throw new Error("Amount must be > 0");
    const stream = this.streams.get(params.streamId);
    if (!stream) throw new Error(`Stream not found: ${params.streamId}`);
    if (stream.status !== "Active") throw new Error("Stream is not active");

    const extraSeconds = Number(params.amount / stream.flowRate);
    const newEndTime = stream.endTime + extraSeconds;
    const newDeposit = stream.deposit + params.amount;
    this.streams.set(params.streamId, {
      ...stream,
      deposit: newDeposit,
      endTime: newEndTime,
    });

    this.emit({
      type: "StreamToppedUp",
      streamId: params.streamId,
      txHash: `mock-tx-topup-${params.streamId}`,
      ledger: 0,
      timestamp: nowSec(),
      data: { amount: params.amount.toString(), newEndTime },
    });

    return {
      txHash: `mock-tx-topup-${params.streamId}`,
      newEndTime: new Date(newEndTime * 1000),
    };
  }

  async getStream(streamId: string): Promise<Stream> {
    const stream = this.streams.get(streamId);
    if (!stream) throw new Error(`Stream not found: ${streamId}`);
    return { ...stream };
  }

  async getClaimable(streamId: string): Promise<bigint> {
    const stream = this.streams.get(streamId);
    if (!stream) return 0n;
    return claimableAt(stream, nowSec());
  }

  async getStreamsBySender(
    sender: string,
    pagination?: PaginationParams
  ): Promise<Stream[] | PaginatedStreams> {
    const all = Array.from(this.streams.values()).filter(
      (s) => s.sender === sender
    );
    return this._paginate(all, pagination);
  }

  async getStreamsByRecipient(
    recipient: string,
    pagination?: PaginationParams
  ): Promise<Stream[] | PaginatedStreams> {
    const all = Array.from(this.streams.values()).filter(
      (s) => s.recipient === recipient
    );
    return this._paginate(all, pagination);
  }

  private _paginate(
    all: Stream[],
    pagination?: PaginationParams
  ): Stream[] | PaginatedStreams {
    if (!pagination) return all;
    const limit = pagination.limit ?? 20;
    const start = pagination.cursor
      ? all.findIndex((s) => s.id === pagination.cursor) + 1
      : 0;
    const page = all.slice(start, start + limit);
    const last = page[page.length - 1];
    return {
      streams: page,
      cursor: last ? last.id : null,
      hasMore: start + limit < all.length,
    };
  }

  subscribeEvents(
    filter: StreamEventFilter,
    callback: (event: StreamEvent) => void
  ): StreamSubscription {
    const key = `mock-sub-${Date.now()}-${Math.random()}`;
    this.listeners.set(key, {
      filter: (event) => {
        if (filter.streamId && event.streamId !== filter.streamId) return false;
        if (filter.sender && event.data.sender !== filter.sender) return false;
        if (filter.recipient && event.data.recipient !== filter.recipient) return false;
        return true;
      },
      callback,
    });
    return { unsubscribe: () => this.listeners.delete(key) };
  }
}
