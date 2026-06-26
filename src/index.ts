export { SoroStreamClient } from "./SoroStreamClient.js";
// Wallet adapters are available at "@sorostream/sdk/wallets" to keep the core
// bundle free of browser-only @stellar/freighter-api code. The non-browser
// multisig and claim-delegate adapters are still re-exported here for convenience.
export { createMultisigAdapter, createClaimDelegateAdapter } from "./wallet.js";
export type { ClaimDelegateConfig } from "./wallet.js";

export { MockSoroStreamClient } from "./mock.js";
export { WebhookForwarder } from "./webhook.js";
export {
  toStroops,
  formatUSDC,
  formatToken,
  toFiatDisplay,
  isValidStellarAddress,
  calculateFlowRate,
  timeUntilStreamEnd,
  claimableNow,
  calculateVestingSchedule,
  watchClaimable,
  aggregateStreamsByToken,
  parseCsvStreamRows,
} from "./utils.js";
export { templates } from "./templates.js";
export { CircuitBreaker } from "./circuitBreaker.js";
export type { CircuitState, CircuitBreakerOptions } from "./circuitBreaker.js";
export { createContractEncoder } from "./contractEncoders.js";
export type { ContractCallEncoder } from "./contractEncoders.js";
export { createSimplePriceFeed } from "./priceFeed.js";
export type { SimplePriceFeedOptions } from "./priceFeed.js";
export {
  SoroStreamError,
  InsufficientAmountError,
  StreamNotFoundError,
  StreamNotActiveError,
  TransactionFailedError,
  InvalidAddressError,
  AccountNotFoundError,
  InsufficientBalanceError,
} from "./errors.js";
export type {
  Stream,
  StreamStatus,
  CreateStreamParams,
  WithdrawParams,
  CancelStreamParams,
  TopUpParams,
  Network,
  WalletAdapter,
  FeeEstimate,
  VestingSchedulePoint,
  VestingScheduleResult,
  WatchClaimableOptions,
  BulkStreamRow,
  BulkCreateOptions,
  BulkCreateBatchResult,
  BulkCreateResult,
  BatchWithdrawResult,
  TokenAggregate,
  MultisigSigner,
  StreamEvent,
  StreamEventType,
  StreamEventFilter,
  StreamSubscription,
  PaginationParams,
  PaginatedStreams,
  WebhookConfig,
  PriceFeedAdapter,
  FeeBumpOptions,
  WriteOptions,
  ContractVersion,
} from "./types.js";
