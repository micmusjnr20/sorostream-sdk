/** Status of a payment stream. */
export type StreamStatus = "Active" | "Cancelled" | "Completed";

// ── Event types (#1) ─────────────────────────────────────────────────────────

export type StreamEventType =
  | "StreamCreated"
  | "StreamWithdrawn"
  | "StreamCancelled"
  | "StreamCompleted"
  | "StreamToppedUp";

export interface StreamEvent {
  type: StreamEventType;
  streamId: string;
  txHash: string;
  ledger: number;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface StreamSubscription {
  unsubscribe(): void;
}

export interface StreamEventFilter {
  streamId?: string;
  sender?: string;
  recipient?: string;
}

// ── Pagination types (#3) ────────────────────────────────────────────────────

export interface PaginationParams {
  limit?: number;
  cursor?: string;
}

export interface PaginatedStreams {
  streams: Stream[];
  cursor: string | null;
  hasMore: boolean;
}

// ── Multisig types (#16) ─────────────────────────────────────────────────────

export interface MultisigSigner {
  signTransaction(xdr: string, network: Network): Promise<string>;
}

// ── Webhook types (#22) ──────────────────────────────────────────────────────

export interface WebhookConfig {
  url: string;
  headers?: Record<string, string>;
  retries?: number;
  retryDelayMs?: number;
}

/** A single payment stream as returned by the contract. */
export interface Stream {
  /** Unique stream identifier. */
  id: string;
  /** Address of the stream creator / payer. */
  sender: string;
  /** Address of the stream beneficiary. */
  recipient: string;
  /** SAC token contract address (e.g. USDC). */
  token: string;
  /** Total token deposit locked in stroops. */
  deposit: bigint;
  /** Tokens released per second in stroops. */
  flowRate: bigint;
  /** Unix timestamp when the stream started. */
  startTime: number;
  /** Unix timestamp when the stream ends. */
  endTime: number;
  /** Unix timestamp of the last withdrawal. */
  lastWithdrawTime: number;
  /** Current stream status. */
  status: StreamStatus;
  /** Whether the stream auto-renews on completion. */
  autoRenew: boolean;
}

/** Parameters for creating a new stream. */
export interface CreateStreamParams {
  /** Beneficiary address. */
  recipient: string;
  /** SAC token contract address. */
  token: string;
  /** Total amount to stream in stroops. */
  amount: bigint;
  /** Stream duration in seconds. */
  durationSeconds: number;
  /** Whether to auto-renew on completion. */
  autoRenew: boolean;
}

/** Parameters for withdrawing from a stream. */
export interface WithdrawParams {
  /** Stream ID to withdraw from. */
  streamId: string;
}

/** Parameters for cancelling a stream. */
export interface CancelStreamParams {
  /** Stream ID to cancel. */
  streamId: string;
}

/** Parameters for topping up a stream. */
export interface TopUpParams {
  /** Stream ID to top up. */
  streamId: string;
  /** Additional amount to add in stroops. */
  amount: bigint;
}

/** Network configuration. */
export type Network = "mainnet" | "testnet" | "futurenet";

/** Wallet adapter interface. Implement this to support custom signing backends. */
export interface WalletAdapter {
  getPublicKey(): Promise<string>;
  signTransaction(xdr: string, network: Network): Promise<string>;
  isConnected(): Promise<boolean>;
}

/** A single row for bulk stream creation. */
export interface BulkStreamRow {
  recipient: string;
  amount: bigint;
  durationSeconds: number;
}

/** Options for bulkCreateStreams. */
export interface BulkCreateOptions {
  /** SAC token contract address applied to every row. */
  token: string;
  /** Whether auto-renew is enabled (default false). */
  autoRenew?: boolean;
  /** Max operations per transaction (default 8). */
  batchSize?: number;
}

/** Result of one batch within a bulk create. */
export interface BulkCreateBatchResult {
  txHash: string;
  streamIds: string[];
  rows: BulkStreamRow[];
}

/** Full result of bulkCreateStreams. */
export interface BulkCreateResult {
  batches: BulkCreateBatchResult[];
}

/** Result of one transaction within a batchWithdraw call. */
export interface BatchWithdrawResult {
  txHash: string;
  streamIds: string[];
  amounts: string[];
}

/** Per-token aggregate of a set of streams. */
export interface TokenAggregate {
  token: string;
  streamCount: number;
  deposited: bigint;
  claimable: bigint;
  claimedSoFar: bigint;
}
