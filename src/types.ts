/** Status of a payment stream. */
export type StreamStatus = "Active" | "Cancelled" | "Completed";

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

/** Client-side filter criteria for {@link filterStreams}. */
export interface StreamFilterCriteria {
  /** Match streams with this status (or any of these statuses). */
  status?: StreamStatus | StreamStatus[];
  /** Match streams for this SAC token contract address. */
  token?: string;
  /** Include streams whose start time is strictly after this unix timestamp. */
  startsAfter?: number;
  /** Include streams whose end time is strictly before this unix timestamp. */
  endsBefore?: number;
}

/** Wallet adapter interface. */
export interface WalletAdapter {
  getPublicKey(): Promise<string>;
  signTransaction(xdr: string, network: Network): Promise<string>;
  isConnected(): Promise<boolean>;
}
