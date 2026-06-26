import {
  Contract,
  Networks,
  TransactionBuilder,
  BASE_FEE,
  rpc,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { EventPoller } from "./events.js";
import type {
  BatchWithdrawResult,
  BulkCreateOptions,
  BulkCreateResult,
  CancelStreamParams,
  CreateStreamParams,
  CreateStreamsParams,
  FeeEstimate,
  Network,
  PaginatedStreams,
  PaginationParams,
  Stream,
  StreamEvent,
  StreamEventFilter,
  StreamSubscription,
  TopUpParams,
  WalletAdapter,
  WithdrawParams,
  WriteOptions,
  CircuitBreakerOptions as CircuitBreakerOptionsType,
} from "./types.js";
import { CircuitBreaker } from "./circuitBreaker.js";

const RPC_URLS: Record<Network, string> = {
  mainnet: "https://soroban.stellar.org",
  testnet: "https://soroban-testnet.stellar.org",
  futurenet: "https://rpc-futurenet.stellar.org",
};

const NETWORK_PASSPHRASES: Record<Network, string> = {
  mainnet: Networks.PUBLIC,
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
};

/** Options for constructing a SoroStreamClient. */
export interface SoroStreamClientOptions {
  /** The Stellar network to connect to. */
  network: Network;
  /** The deployed StreamContract address. */
  contractId: string;
  /** Wallet adapter for signing transactions. */
  walletAdapter: WalletAdapter;
  /** Optional custom RPC URL (overrides default). */
  rpcUrl?: string;
  /** Optional circuit-breaker configuration for RPC calls. */
  circuitBreaker?: CircuitBreakerOptionsType;
  /** Maximum time in ms to wait for a transaction to confirm (default: 120000). */
  txTimeoutMs?: number;
}

/** Maps a raw Soroban contract value to a Stream object. */
function scValToStream(val: xdr.ScVal): Stream {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = scValToNative(val) as Record<string, any>;
  return {
    id: String(raw["id"]),
    sender: String(raw["sender"]),
    recipient: String(raw["recipient"]),
    token: String(raw["token"]),
    deposit: BigInt(raw["deposit"]),
    flowRate: BigInt(raw["flow_rate"]),
    startTime: Number(raw["start_time"]),
    endTime: Number(raw["end_time"]),
    lastWithdrawTime: Number(raw["last_withdraw_time"]),
    status: raw["status"] as Stream["status"],
    autoRenew: Boolean(raw["auto_renew"]),
  };
}

export type SimulateOnlyResult = {
  simulated: true;
  result: rpc.Api.SimulateTransactionResponse;
};

/**
 * Main client for interacting with the SoroStream contract.
 *
 * @example
 * ```ts
 * const client = new SoroStreamClient({ network: "testnet", contractId: "...", walletAdapter });
 * const { streamId } = await client.createStream({ recipient, token, amount, durationSeconds, autoRenew });
 * ```
 */
export class SoroStreamClient {
  private readonly rpcUrls: string[];
  private readonly contract: Contract;
  private readonly network: Network;
  private readonly walletAdapter: WalletAdapter;
  private readonly txTimeoutMs: number;
  private eventPoller: EventPoller | null = null;

  constructor(options: SoroStreamClientOptions) {
    this.network = options.network;
    this.walletAdapter = options.walletAdapter;
    this.contract = new Contract(options.contractId);
    this.server = new rpc.Server(options.rpcUrl ?? RPC_URLS[options.network], {
      allowHttp: false,
    });
    this.txTimeoutMs = options.txTimeoutMs ?? 120_000;
  }

  private async buildAndSubmit(
    operation: xdr.Operation,
    signal?: AbortSignal
  ): Promise<string> {
    const publicKey = await this.walletAdapter.getPublicKey();
    const account = await this.withBreaker(() => this.server.getAccount(publicKey));

    let builder = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASES[this.network],
    });
    for (const op of operations) {
      builder = builder.addOperation(op);
    }
    const tx = builder.setTimeout(30).build();

    const preparedTx = await this.withBreaker(() =>
      this.server.prepareTransaction(tx)
    );
    const signedXdr = await this.walletAdapter.signTransaction(
      preparedTx.toXDR(),
      this.network
    );

    const result = await this.withBreaker(() =>
      this.server.sendTransaction(
        TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASES[this.network])
      )
    );

    if (result.status === "ERROR") {
      throw new TransactionFailedError(JSON.stringify(result.errorResult));
    }

    // Poll for completion with configurable timeout and exponential backoff
    const startTime = Date.now();
    let delay = 500;
    const maxDelay = 10_000;

    let response = await this.server.getTransaction(result.hash);
    while (response.status === "NOT_FOUND") {
      if (signal?.aborted) {
        throw new DOMException("Transaction polling aborted", "AbortError");
      }

      const elapsed = Date.now() - startTime;
      if (elapsed >= this.txTimeoutMs) {
        throw new Error(
          `Transaction confirmation timed out after ${this.txTimeoutMs}ms`
        );
      }

      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, maxDelay);

      response = await this.server.getTransaction(result.hash);
    }

    if (response.status === "FAILED") {
      throw new TransactionFailedError(result.hash);
    }

    return result.hash;
  }

  private async buildAndSubmitBatch(operations: xdr.Operation[]): Promise<string> {
    const publicKey = await this.walletAdapter.getPublicKey();
    const account = await this.server.getAccount(publicKey);

    let builder = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASES[this.network],
    });
    for (const op of operations) {
      builder = builder.addOperation(op);
    }
    const tx = builder.setTimeout(30).build();

    const preparedTx = await this.server.prepareTransaction(tx);
    const signedXdr = await this.walletAdapter.signTransaction(
      preparedTx.toXDR(),
      this.network
    );

  private async buildAndSubmit(operation: xdr.Operation): Promise<string> {
    return this.withServer(async (server) => {
      const publicKey = await this.walletAdapter.getPublicKey();
      const account = await server.getAccount(publicKey);

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASES[this.network],
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();

      const preparedTx = await server.prepareTransaction(tx);
      const signedXdr = await this.walletAdapter.signTransaction(
        preparedTx.toXDR(),
        this.network
      );

      const result = await server.sendTransaction(
        TransactionBuilder.fromXDR(
          signedXdr,
          NETWORK_PASSPHRASES[this.network]
        )
      );

      if (result.status === "ERROR") {
        throw new Error(
          `Transaction failed: ${JSON.stringify(result.errorResult)}`
        );
      }

    let response = await this.server.getTransaction(result.hash);
    while (response.status === "NOT_FOUND") {
      await new Promise((r) => setTimeout(r, 1000));
      response = await this.withBreaker(() =>
        this.server.getTransaction(result.hash)
      );
    }

      if (response.status === "FAILED") {
        throw new Error(`Transaction failed: ${result.hash}`);
      }

      return result.hash;
    });
  }

  private async simulateOp(
    operation: xdr.Operation
  ): Promise<rpc.Api.SimulateTransactionResponse> {
    const publicKey = await this.walletAdapter.getPublicKey();
    const account = await this.withBreaker(() => this.server.getAccount(publicKey));
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASES[this.network],
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();
    return this.withBreaker(() => this.server.simulateTransaction(tx));
  }

  /**
   * Creates a new payment stream.
   * @param params - Stream creation parameters.
   * @param options - Optional write options (e.g. simulateOnly).
   * @returns The new stream ID and transaction hash, or simulation result.
   */
  async createStream(
    params: CreateStreamParams,
    signal?: AbortSignal
  ): Promise<{ streamId: string; txHash: string }> {
    if (params.amount <= 0n) throw new InsufficientAmountError();
    if (params.durationSeconds <= 0) throw new InsufficientAmountError("Duration must be > 0");

    const sender = await this.walletAdapter.getPublicKey();

    const operation = this.contract.call(
      "create_stream",
      nativeToScVal(sender, { type: "address" }),
      nativeToScVal(params.recipient, { type: "address" }),
      nativeToScVal(params.token, { type: "address" }),
      nativeToScVal(params.amount, { type: "i128" }),
      nativeToScVal(params.durationSeconds, { type: "u64" }),
      nativeToScVal(params.autoRenew, { type: "bool" })
    );

    const txHash = await this.buildAndSubmit(operation, signal);

    // Fetch latest stream for sender to get ID
    const result = await this.getStreamsBySender(sender);
    const streams = Array.isArray(result) ? result : result.streams;
    const latest = streams[streams.length - 1];
    if (!latest) throw new StreamNotFoundError("(unknown — post-creation fetch returned empty)");

    return { streamId: latest.id, txHash };
  }

  /**
   * Creates multiple payment streams in a single transaction.
   * @param paramsArray - Array of stream creation parameters.
   * @param options - Optional write options (e.g. simulateOnly).
   * @returns Array of stream IDs and the transaction hash, or simulation result.
   */
  async createStreams(
    paramsArray: CreateStreamParams[],
    options?: WriteOptions
  ): Promise<
    { streamIds: string[]; txHash: string } | SimulateOnlyResult
  > {
    if (paramsArray.length === 0) throw new Error("At least one stream is required");
    for (const params of paramsArray) {
      if (params.amount <= 0n) throw new Error("Amount must be > 0");
      if (params.durationSeconds <= 0) throw new Error("Duration must be > 0");
    }

    const sender = await this.walletAdapter.getPublicKey();

    const operations = paramsArray.map((params) =>
      this.contract.call(
        "create_stream",
        nativeToScVal(sender, { type: "address" }),
        nativeToScVal(params.recipient, { type: "address" }),
        nativeToScVal(params.token, { type: "address" }),
        nativeToScVal(params.amount, { type: "i128" }),
        nativeToScVal(params.durationSeconds, { type: "u64" }),
        nativeToScVal(params.autoRenew, { type: "bool" })
      )
    );

    if (options?.simulateOnly) {
      const result = await this.simulateOp(operations[0]);
      return { simulated: true, result };
    }

    const before = await this.getStreamsBySender(sender);
    const txHash = await this.buildAndSubmit(operations);
    const after = await this.getStreamsBySender(sender);
    const streamIds = after.slice(before.length).map((s) => s.id);

    return { streamIds, txHash };
  }

  /**
   * Withdraws all currently claimable tokens from a stream.
   * @param params - Withdraw parameters.
   * @param options - Optional write options (e.g. simulateOnly).
   * @returns The transaction hash and withdrawn amount, or simulation result.
   */
  async withdraw(
    params: WithdrawParams,
    signal?: AbortSignal
  ): Promise<{ txHash: string; amount: string }> {
    const recipient = await this.walletAdapter.getPublicKey();
    const claimable = await this.getClaimable(params.streamId);

    const operation = this.contract.call(
      "withdraw",
      nativeToScVal(BigInt(params.streamId), { type: "u64" }),
      nativeToScVal(recipient, { type: "address" })
    );

    const txHash = await this.buildAndSubmit(operation, signal);
    return { txHash, amount: claimable.toString() };
  }

  /**
   * Withdraws from multiple streams in a single transaction.
   * Streams are grouped into batches to stay within Stellar's per-transaction
   * operation limit. Each batch becomes one submitted transaction.
   *
   * @param streamIds - Array of stream IDs to withdraw from.
   * @param batchSize - Max operations per transaction (default 8).
   * @returns Array of batch results, one per transaction.
   *
   * @example
   * ```ts
   * const results = await client.batchWithdraw(["1", "2", "3"]);
   * for (const b of results) console.log(b.txHash, b.amounts);
   * ```
   */
  async batchWithdraw(
    streamIds: string[],
    batchSize = 8
  ): Promise<BatchWithdrawResult[]> {
    const results: BatchWithdrawResult[] = [];
    const recipient = await this.walletAdapter.getPublicKey();

    for (let i = 0; i < streamIds.length; i += batchSize) {
      const chunk = streamIds.slice(i, i + batchSize);
      const operations = chunk.map((id) =>
        this.contract.call(
          "withdraw",
          nativeToScVal(BigInt(id), { type: "u64" }),
          nativeToScVal(recipient, { type: "address" })
        )
      );

      const amounts: string[] = [];
      for (const id of chunk) {
        const claimable = await this.getClaimable(id);
        amounts.push(claimable.toString());
      }

      const txHash = await this.buildAndSubmitBatch(operations);
      results.push({ txHash, streamIds: chunk, amounts });
    }

    return results;
  }

  /**
   * Cancels an active stream. Refunds unstreamed tokens to sender.
   * @param params - Cancel parameters.
   * @param options - Optional write options (e.g. simulateOnly).
   * @returns The transaction hash, or simulation result.
   */
  async cancelStream(
    params: CancelStreamParams,
    signal?: AbortSignal
  ): Promise<{ txHash: string }> {
    const sender = await this.walletAdapter.getPublicKey();

    const operation = this.contract.call(
      "cancel_stream",
      nativeToScVal(BigInt(params.streamId), { type: "u64" }),
      nativeToScVal(sender, { type: "address" })
    );

    const txHash = await this.buildAndSubmit(operation, signal);
    return { txHash };
  }

  /**
   * Tops up an existing stream with additional tokens, extending its duration.
   * @param params - Top-up parameters.
   * @param options - Optional write options (e.g. simulateOnly).
   * @returns The transaction hash and new end time, or simulation result.
   */
  async topUp(
    params: TopUpParams,
    signal?: AbortSignal
  ): Promise<{ txHash: string; newEndTime: Date }> {
    if (params.amount <= 0n) throw new Error("Amount must be > 0");
    const sender = await this.walletAdapter.getPublicKey();

    const operation = this.contract.call(
      "top_up",
      nativeToScVal(BigInt(params.streamId), { type: "u64" }),
      nativeToScVal(sender, { type: "address" }),
      nativeToScVal(params.amount, { type: "i128" })
    );

    const txHash = await this.buildAndSubmit(operation, signal);
    const stream = await this.getStream(params.streamId);
    return { txHash, newEndTime: new Date(stream.endTime * 1000) };
  }

  // ── Fee estimation ──────────────────────────────────────────────────────────

  private async estimateOperationFee(
    operation: xdr.Operation
  ): Promise<FeeEstimate> {
    const publicKey = await this.walletAdapter.getPublicKey();
    const account = await this.server.getAccount(publicKey);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASES[this.network],
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const preparedTx = await this.server.prepareTransaction(tx);

    const minResourceFee = (
      preparedTx as unknown as { minResourceFee?: number }
    ).minResourceFee ?? 0;

    return {
      totalFee: preparedTx.fee + minResourceFee,
      minResourceFee,
    };
  }

  /**
   * Estimates the network fee for a createStream transaction.
   * The returned value is an estimate — actual fee may differ.
   */
  async estimateCreateStreamFee(
    params: CreateStreamParams
  ): Promise<FeeEstimate> {
    if (params.amount <= 0n) throw new Error("Amount must be > 0");
    if (params.durationSeconds <= 0) throw new Error("Duration must be > 0");

    const sender = await this.walletAdapter.getPublicKey();

    const operation = this.contract.call(
      "create_stream",
      nativeToScVal(sender, { type: "address" }),
      nativeToScVal(params.recipient, { type: "address" }),
      nativeToScVal(params.token, { type: "address" }),
      nativeToScVal(params.amount, { type: "i128" }),
      nativeToScVal(params.durationSeconds, { type: "u64" }),
      nativeToScVal(params.autoRenew, { type: "bool" })
    );

    return this.estimateOperationFee(operation);
  }

  /**
   * Estimates the network fee for a withdraw transaction.
   * The returned value is an estimate — actual fee may differ.
   */
  async estimateWithdrawFee(params: WithdrawParams): Promise<FeeEstimate> {
    const recipient = await this.walletAdapter.getPublicKey();

    const operation = this.contract.call(
      "withdraw",
      nativeToScVal(BigInt(params.streamId), { type: "u64" }),
      nativeToScVal(recipient, { type: "address" })
    );

    return this.estimateOperationFee(operation);
  }

  /**
   * Estimates the network fee for a cancelStream transaction.
   * The returned value is an estimate — actual fee may differ.
   */
  async estimateCancelStreamFee(params: CancelStreamParams): Promise<FeeEstimate> {
    const sender = await this.walletAdapter.getPublicKey();

    const operation = this.contract.call(
      "cancel_stream",
      nativeToScVal(BigInt(params.streamId), { type: "u64" }),
      nativeToScVal(sender, { type: "address" })
    );

    return this.estimateOperationFee(operation);
  }

  /**
   * Estimates the network fee for a topUp transaction.
   * The returned value is an estimate — actual fee may differ.
   */
  async estimateTopUpFee(params: TopUpParams): Promise<FeeEstimate> {
    if (params.amount <= 0n) throw new Error("Amount must be > 0");
    const sender = await this.walletAdapter.getPublicKey();

    const operation = this.contract.call(
      "top_up",
      nativeToScVal(BigInt(params.streamId), { type: "u64" }),
      nativeToScVal(sender, { type: "address" }),
      nativeToScVal(params.amount, { type: "i128" })
    );

    return this.estimateOperationFee(operation);
  private getEventPoller(): EventPoller {
    if (!this.eventPoller) {
      this.eventPoller = new EventPoller(this.server, this.contract.contractId());
    }
    return this.eventPoller;
  }

  /**
   * Subscribes to real-time stream lifecycle events matching the given filter.
   * The callback is invoked each time a matching event is detected.
   *
   * @example
   * ```ts
   * const sub = client.subscribeEvents({ streamId: "42" }, (event) => {
   *   console.log(event.type, event.streamId);
   * });
   * // later: sub.unsubscribe();
   * ```
   */
  subscribeEvents(
    filter: StreamEventFilter,
    callback: (event: StreamEvent) => void
  ): StreamSubscription {
    const poller = this.getEventPoller();
    const key = `${filter.streamId ?? "*"}:${filter.sender ?? "*"}:${filter.recipient ?? "*"}:${Date.now()}`;

    return poller.subscribe(key, {
      filter: (event) => {
        if (filter.streamId && event.streamId !== filter.streamId) return false;
        if (filter.sender && event.data.sender !== filter.sender) return false;
        if (filter.recipient && event.data.recipient !== filter.recipient) return false;
        return true;
      },
      callback,
    });
  }

  /**
   * Returns the full stream data for a given stream ID.
   * @param streamId - The stream ID to look up.
   */
  async getStream(streamId: string): Promise<Stream> {
    const publicKey = await this.walletAdapter.getPublicKey();
    const account = await this.withBreaker(() => this.server.getAccount(publicKey));
    const result = await this.withBreaker(() =>
      this.server.simulateTransaction(
        new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase: NETWORK_PASSPHRASES[this.network],
        })
          .addOperation(
            this.contract.call(
              "get_stream",
              nativeToScVal(BigInt(streamId), { type: "u64" })
            )
          )
          .setTimeout(30)
          .build()
      )
    );

    if (rpc.Api.isSimulationError(result)) {
      throw new StreamNotFoundError(streamId);
    }

    const returnVal = (result as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    if (!returnVal) throw new Error("No return value from contract");
    return scValToStream(returnVal);
  }

  /**
   * Returns the currently claimable amount in stroops for a stream.
   * @param streamId - The stream ID to check.
   */
  async getClaimable(streamId: string): Promise<bigint> {
    const publicKey = await this.walletAdapter.getPublicKey();
    const account = await this.withBreaker(() => this.server.getAccount(publicKey));
    const result = await this.withBreaker(() =>
      this.server.simulateTransaction(
        new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase: NETWORK_PASSPHRASES[this.network],
        })
          .addOperation(
            this.contract.call(
              "get_claimable",
              nativeToScVal(BigInt(streamId), { type: "u64" })
            )
          )
          .setTimeout(30)
          .build()
      )
    );

      if (rpc.Api.isSimulationError(result)) return 0n;

      const returnVal = (
        result as rpc.Api.SimulateTransactionSuccessResponse
      ).result?.retval;
      if (!returnVal) return 0n;
      return BigInt(scValToNative(returnVal) as number);
    });
  }

  /**
   * Returns all streams created by a sender address.
   * When `pagination` is omitted, returns the full result set (backward-compatible).
   *
   * @param sender - The sender address to query.
   * @param pagination - Optional limit/cursor for paginated results.
   */
  async getStreamsBySender(
    sender: string,
    pagination?: PaginationParams
  ): Promise<Stream[] | PaginatedStreams> {
    const args: xdr.ScVal[] = [nativeToScVal(sender, { type: "address" })];

    if (pagination) {
      args.push(nativeToScVal(pagination.limit ?? 20, { type: "u32" }));
      args.push(
        pagination.cursor != null
          ? nativeToScVal(BigInt(pagination.cursor), { type: "u64" })
          : xdr.ScVal.scvVoid()
      );
    }

    const result = await this.server.simulateTransaction(
      new TransactionBuilder(
        await this.server.getAccount(await this.walletAdapter.getPublicKey()),
        { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASES[this.network] }
      )
        .addOperation(this.contract.call("get_streams_by_sender", ...args))
        .setTimeout(30)
        .build()
    );

    if (rpc.Api.isSimulationError(result)) {
      return pagination ? { streams: [], cursor: null, hasMore: false } : [];
    }

    const returnVal = (result as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    if (!returnVal) {
      return pagination ? { streams: [], cursor: null, hasMore: false } : [];
    }

    const raw = scValToNative(returnVal) as xdr.ScVal[];
    const streams = raw.map(scValToStream);

    if (!pagination) return streams;

    const p = pagination!;
    const limit = p.limit ?? 20;
    const last = streams[streams.length - 1];
    return {
      streams,
      cursor: last ? last.id : null,
      hasMore: streams.length >= limit,
    };
  }

  /**
   * Returns all streams targeting a recipient address.
   * When `pagination` is omitted, returns the full result set (backward-compatible).
   *
   * @param recipient - The recipient address to query.
   * @param pagination - Optional limit/cursor for paginated results.
   */
  async getStreamsByRecipient(
    recipient: string,
    pagination?: PaginationParams
  ): Promise<Stream[] | PaginatedStreams> {
    const args: xdr.ScVal[] = [nativeToScVal(recipient, { type: "address" })];

    if (pagination) {
      args.push(nativeToScVal(pagination.limit ?? 20, { type: "u32" }));
      args.push(
        pagination.cursor != null
          ? nativeToScVal(BigInt(pagination.cursor), { type: "u64" })
          : xdr.ScVal.scvVoid()
      );
    }

    const result = await this.server.simulateTransaction(
      new TransactionBuilder(
        await this.server.getAccount(await this.walletAdapter.getPublicKey()),
        { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASES[this.network] }
      )
        .addOperation(this.contract.call("get_streams_by_recipient", ...args))
        .setTimeout(30)
        .build()
    );

    if (rpc.Api.isSimulationError(result)) {
      return pagination ? { streams: [], cursor: null, hasMore: false } : [];
    }

    const returnVal = (result as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    if (!returnVal) {
      return pagination ? { streams: [], cursor: null, hasMore: false } : [];
    }

    const raw = scValToNative(returnVal) as xdr.ScVal[];
    const streams = raw.map(scValToStream);

    if (!pagination) return streams;

    const p = pagination!;
    const limit = p.limit ?? 20;
    const last = streams[streams.length - 1];
    return {
      streams,
      cursor: last ? last.id : null,
      hasMore: streams.length >= limit,
    };
  }

  /**
   * Creates multiple streams in bulk, batching operations into transactions.
   *
   * Rows are grouped into batches (default 8 per transaction). When a batch fits
   * within one Soroban transaction it is submitted together; batches beyond the
   * per-transaction operation limit are submitted as sequential transactions.
   *
   * @param rows - Array of stream rows (recipient, amount, durationSeconds).
   * @param options - Shared token contract address, optional autoRenew and batchSize.
   * @returns Per-batch results with stream IDs and transaction hashes.
   *
   * @example
   * ```ts
   * const { batches } = await client.bulkCreateStreams(
   *   [{ recipient: "G...", amount: toStroops("100"), durationSeconds: 86400 }],
   *   { token: "GUSDC...", autoRenew: false }
   * );
   * ```
   */
  async bulkCreateStreams(
    rows: import("./types.js").BulkStreamRow[],
    options: BulkCreateOptions
  ): Promise<BulkCreateResult> {
    const sender = await this.walletAdapter.getPublicKey();
    const token = options.token;
    const autoRenew = options.autoRenew ?? false;
    const batchSize = options.batchSize ?? 8;

    const results: BulkCreateResult["batches"] = [];

    for (let i = 0; i < rows.length; i += batchSize) {
      const chunk = rows.slice(i, i + batchSize);
      const operations = chunk.map((row) =>
        this.contract.call(
          "create_stream",
          nativeToScVal(sender, { type: "address" }),
          nativeToScVal(row.recipient, { type: "address" }),
          nativeToScVal(token, { type: "address" }),
          nativeToScVal(row.amount, { type: "i128" }),
          nativeToScVal(row.durationSeconds, { type: "u64" }),
          nativeToScVal(autoRenew, { type: "bool" })
        )
      );

      const txHash = await this.buildAndSubmitBatch(operations);

      const streams = await this.getStreamsBySender(sender);
      const newStreams = streams.slice(-chunk.length);
      const streamIds = newStreams.map((s) => s.id);

      results.push({ txHash, streamIds, rows: chunk });
    }

    return { batches: results };
  }

  /**
   * Returns the underlying CircuitBreaker instance, if configured.
   */
  getCircuitBreaker(): CircuitBreaker | null {
    return this.breaker;
  }
}
