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
} from "./types.js";

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
  private readonly server: rpc.Server;
  private readonly contract: Contract;
  private readonly network: Network;
  private readonly walletAdapter: WalletAdapter;
  private eventPoller: EventPoller | null = null;

  constructor(options: SoroStreamClientOptions) {
    this.network = options.network;
    this.walletAdapter = options.walletAdapter;
    this.contract = new Contract(options.contractId);
    this.server = new rpc.Server(options.rpcUrl ?? RPC_URLS[options.network], {
      allowHttp: false,
    });
  }

  private async buildAndSubmit(operation: xdr.Operation): Promise<string> {
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
    const signedXdr = await this.walletAdapter.signTransaction(
      preparedTx.toXDR(),
      this.network
    );

    const result = await this.server.sendTransaction(
      TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASES[this.network])
    );

    if (result.status === "ERROR") {
      throw new Error(`Transaction failed: ${JSON.stringify(result.errorResult)}`);
    }

    // Poll for completion
    let response = await this.server.getTransaction(result.hash);
    while (response.status === "NOT_FOUND") {
      await new Promise((r) => setTimeout(r, 1000));
      response = await this.server.getTransaction(result.hash);
    }

    if (response.status === "FAILED") {
      throw new Error(`Transaction failed: ${result.hash}`);
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

    const result = await this.server.sendTransaction(
      TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASES[this.network])
    );

    if (result.status === "ERROR") {
      throw new Error(`Transaction failed: ${JSON.stringify(result.errorResult)}`);
    }

    let response = await this.server.getTransaction(result.hash);
    while (response.status === "NOT_FOUND") {
      await new Promise((r) => setTimeout(r, 1000));
      response = await this.server.getTransaction(result.hash);
    }

    if (response.status === "FAILED") {
      throw new Error(`Transaction failed: ${result.hash}`);
    }

    return result.hash;
  }

  /**
   * Creates a new payment stream.
   * @param params - Stream creation parameters.
   * @returns The new stream ID and transaction hash.
   */
  async createStream(
    params: CreateStreamParams
  ): Promise<{ streamId: string; txHash: string }> {
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

    const txHash = await this.buildAndSubmit(operation);

    // Fetch latest stream for sender to get ID
    const result = await this.getStreamsBySender(sender);
    const streams = Array.isArray(result) ? result : result.streams;
    const latest = streams[streams.length - 1];
    if (!latest) throw new Error("Stream not found after creation");

    return { streamId: latest.id, txHash };
  }

  /**
   * Withdraws all currently claimable tokens from a stream.
   * @param params - Withdraw parameters.
   * @returns The transaction hash and withdrawn amount.
   */
  async withdraw(params: WithdrawParams): Promise<{ txHash: string; amount: string }> {
    const recipient = await this.walletAdapter.getPublicKey();
    const claimable = await this.getClaimable(params.streamId);

    const operation = this.contract.call(
      "withdraw",
      nativeToScVal(BigInt(params.streamId), { type: "u64" }),
      nativeToScVal(recipient, { type: "address" })
    );

    const txHash = await this.buildAndSubmit(operation);
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
   * @returns The transaction hash.
   */
  async cancelStream(params: CancelStreamParams): Promise<{ txHash: string }> {
    const sender = await this.walletAdapter.getPublicKey();

    const operation = this.contract.call(
      "cancel_stream",
      nativeToScVal(BigInt(params.streamId), { type: "u64" }),
      nativeToScVal(sender, { type: "address" })
    );

    const txHash = await this.buildAndSubmit(operation);
    return { txHash };
  }

  /**
   * Tops up an existing stream with additional tokens, extending its duration.
   * @param params - Top-up parameters.
   * @returns The transaction hash and new end time.
   */
  async topUp(params: TopUpParams): Promise<{ txHash: string; newEndTime: Date }> {
    if (params.amount <= 0n) throw new Error("Amount must be > 0");
    const sender = await this.walletAdapter.getPublicKey();

    const operation = this.contract.call(
      "top_up",
      nativeToScVal(BigInt(params.streamId), { type: "u64" }),
      nativeToScVal(sender, { type: "address" }),
      nativeToScVal(params.amount, { type: "i128" })
    );

    const txHash = await this.buildAndSubmit(operation);
    const stream = await this.getStream(params.streamId);
    return { txHash, newEndTime: new Date(stream.endTime * 1000) };
  }

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
    const result = await this.server.simulateTransaction(
      new TransactionBuilder(
        await this.server.getAccount(await this.walletAdapter.getPublicKey()),
        { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASES[this.network] }
      )
        .addOperation(
          this.contract.call(
            "get_stream",
            nativeToScVal(BigInt(streamId), { type: "u64" })
          )
        )
        .setTimeout(30)
        .build()
    );

    if (rpc.Api.isSimulationError(result)) {
      throw new Error(`Stream not found: ${streamId}`);
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
    const result = await this.server.simulateTransaction(
      new TransactionBuilder(
        await this.server.getAccount(await this.walletAdapter.getPublicKey()),
        { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASES[this.network] }
      )
        .addOperation(
          this.contract.call(
            "get_claimable",
            nativeToScVal(BigInt(streamId), { type: "u64" })
          )
        )
        .setTimeout(30)
        .build()
    );

    if (rpc.Api.isSimulationError(result)) return 0n;

    const returnVal = (result as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    if (!returnVal) return 0n;
    return BigInt(scValToNative(returnVal) as number);
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
}
