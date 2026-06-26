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

/** Fee estimate returned by prepareTransaction. */
export interface FeeEstimate {
  /** Total fee in stroops (base fee + min resource fee). */
  totalFee: number;
  /** Soroban resource fee in stroops. */
  minResourceFee: number;
}

/** A single milestone point in a vesting schedule. */
export interface VestingSchedulePoint {
  /** Unix timestamp of the milestone. */
  time: number;
  /** Amount vested in stroops at this point. */
  vested: bigint;
}

/** Result of a display-only vesting schedule calculation. */
export interface VestingScheduleResult {
  /** Effective claimable amount right now in stroops (0 if still in cliff). */
  effectiveClaimable: bigint;
  /** Total amount that vests over the full duration in stroops. */
  totalAmount: bigint;
  /** Unix timestamp when the cliff period ends. */
  cliffEndTime: number;
  /** Whether we are still in the cliff period. */
  inCliff: boolean;
  /** Schedule milestones for UI display (cliff, 25%, 50%, 75%, 100%). */
  milestones: VestingSchedulePoint[];
}

/** Options for {@link watchClaimable}. */
export interface WatchClaimableOptions {
  /** Interval in ms between interpolation ticks (default: 200). */
  tickMs?: number;
  /** Interval in ms between on-chain reconciliations (default: 5000). */
  reconcileMs?: number;
}

/** Wallet adapter interface. */
export interface WalletAdapter {
  getPublicKey(): Promise<string>;
  signTransaction(xdr: string, network: Network): Promise<string>;
  isConnected(): Promise<boolean>;
}
