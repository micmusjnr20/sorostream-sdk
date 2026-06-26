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
import type {
  CancelStreamParams,
  CreateStreamParams,
  FeeEstimate,
  Network,
  Stream,
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
  private readonly txTimeoutMs: number;

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
    params: CreateStreamParams,
    signal?: AbortSignal
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

    const txHash = await this.buildAndSubmit(operation, signal);

    // Fetch latest stream for sender to get ID
    const streams = await this.getStreamsBySender(sender);
    const latest = streams[streams.length - 1];
    if (!latest) throw new Error("Stream not found after creation");

    return { streamId: latest.id, txHash };
  }

  /**
   * Withdraws all currently claimable tokens from a stream.
   * @param params - Withdraw parameters.
   * @returns The transaction hash and withdrawn amount.
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
   * Cancels an active stream. Refunds unstreamed tokens to sender.
   * @param params - Cancel parameters.
   * @returns The transaction hash.
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
   * @returns The transaction hash and new end time.
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
   * @param sender - The sender address to query.
   */
  async getStreamsBySender(sender: string): Promise<Stream[]> {
    const result = await this.server.simulateTransaction(
      new TransactionBuilder(
        await this.server.getAccount(await this.walletAdapter.getPublicKey()),
        { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASES[this.network] }
      )
        .addOperation(
          this.contract.call(
            "get_streams_by_sender",
            nativeToScVal(sender, { type: "address" })
          )
        )
        .setTimeout(30)
        .build()
    );

    if (rpc.Api.isSimulationError(result)) return [];

    const returnVal = (result as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    if (!returnVal) return [];

    const raw = scValToNative(returnVal) as xdr.ScVal[];
    return raw.map(scValToStream);
  }

  /**
   * Returns all streams targeting a recipient address.
   * @param recipient - The recipient address to query.
   */
  async getStreamsByRecipient(recipient: string): Promise<Stream[]> {
    const result = await this.server.simulateTransaction(
      new TransactionBuilder(
        await this.server.getAccount(await this.walletAdapter.getPublicKey()),
        { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASES[this.network] }
      )
        .addOperation(
          this.contract.call(
            "get_streams_by_recipient",
            nativeToScVal(recipient, { type: "address" })
          )
        )
        .setTimeout(30)
        .build()
    );

    if (rpc.Api.isSimulationError(result)) return [];

    const returnVal = (result as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    if (!returnVal) return [];

    const raw = scValToNative(returnVal) as xdr.ScVal[];
    return raw.map(scValToStream);
  }
}
