import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import type { WalletAdapter, Network, MultisigSigner } from "./types.js";

/**
 * Configuration for a claim-delegation adapter.
 *
 * The pattern lets an automated "claim bot" key call `withdraw` on behalf of the
 * recipient without ever holding the recipient's primary key:
 *
 * 1. On-chain: add the bot key as a co-signer on the recipient's Stellar account
 *    with a weight that meets the low-security threshold (e.g. weight 1 on a 1-of-N
 *    multisig). The primary key retains sole control over high-security operations.
 * 2. In the SDK: pass the recipient address as `recipientAddress` and the bot's
 *    {@link MultisigSigner} as `claimBotSigner`.
 *
 * The resulting adapter always presents `recipientAddress` to `getPublicKey()`
 * (so `withdraw` receives the correct recipient auth), but the transaction envelope
 * is signed exclusively by the claim bot key.
 *
 * @example
 * ```ts
 * // Bot key loaded from env — never has custody of the recipient address.
 * const botSigner: MultisigSigner = {
 *   async signTransaction(xdr, network) {
 *     const kp = Keypair.fromSecret(process.env.CLAIM_BOT_SECRET!);
 *     const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
 *     tx.sign(kp);
 *     return tx.toEnvelope().toXDR("base64");
 *   },
 * };
 *
 * const adapter = createClaimDelegateAdapter({
 *   recipientAddress: "GRECIPI...",
 *   claimBotSigner: botSigner,
 * });
 *
 * const client = new SoroStreamClient({ network: "testnet", contractId, walletAdapter: adapter });
 * await client.withdraw({ streamId });
 * ```
 */
export interface ClaimDelegateConfig {
  /** The actual recipient address (passed to `require_auth` on-chain). */
  recipientAddress: string;
  /** A signer representing the claim bot key. */
  claimBotSigner: MultisigSigner;
}

const NETWORK_PASSPHRASES: Record<Network, string> = {
  mainnet: "Public Global Stellar Network ; September 2015",
  testnet: "Test SDF Network ; September 2015",
  futurenet: "Test SDF Future Network ; October 2022",
};

/**
 * Creates a WalletAdapter backed by the Freighter browser extension.
 * Dynamically imports @stellar/freighter-api to avoid SSR issues.
 */
export async function createFreighterAdapter(): Promise<WalletAdapter> {
  const freighter = await import("@stellar/freighter-api");

  return {
    async isConnected(): Promise<boolean> {
      const result = await freighter.isConnected();
      return result.isConnected;
    },

    async getPublicKey(): Promise<string> {
      const result = await freighter.getAddress();
      if (result.error) throw new Error(result.error.message);
      return result.address;
    },

    async signTransaction(xdr: string, network: Network): Promise<string> {
      const result = await freighter.signTransaction(xdr, {
        networkPassphrase: NETWORK_PASSPHRASES[network],
      });
      if (result.error) throw new Error(result.error.message);
      return result.signedTxXdr;
    },
  };
}

/**
 * Creates a server-side WalletAdapter that signs directly with a Stellar Keypair.
 * Suitable for Node.js scripts, backends, and automated payouts.
 *
 * @param secretKey - The Stellar secret key (base-32 encoded seed starting with "S").
 *
 * @example
 * ```ts
 * const adapter = createKeypairAdapter("SAZ...YOUR...SECRET...KEY...");
 * const client = new SoroStreamClient({ network: "testnet", contractId: "...", walletAdapter: adapter });
 * ```
 */
export function createKeypairAdapter(secretKey: string): WalletAdapter {
  const keypair = Keypair.fromSecret(secretKey);

  return {
    async isConnected(): Promise<boolean> {
      return true;
    },

    async getPublicKey(): Promise<string> {
      return keypair.publicKey();
    },

    async signTransaction(xdr: string, network: Network): Promise<string> {
      const tx = TransactionBuilder.fromXDR(
        xdr,
        NETWORK_PASSPHRASES[network]
      );
      tx.sign(keypair);
      return tx.toEnvelope().toXDR("base64");
    },
  };
}

/**
 * Prompts the user to connect their Freighter wallet.
 * Throws if Freighter is not installed or the user rejects.
 */
export async function connectWallet(): Promise<string> {
  const freighter = await import("@stellar/freighter-api");
  const connected = await freighter.isConnected();
  if (!connected.isConnected) {
    throw new Error("Freighter extension is not installed");
  }
  const result = await freighter.getAddress();
  if (result.error) throw new Error(result.error.message);
  return result.address;
}

/**
 * Creates a WalletAdapter for a multi-sig Stellar account.
 *
 * The adapter collects signatures from each signer and combines them into
 * a single transaction envelope before submission. This works with Soroban's
 * `require_auth()` calls, which handle classic multisig accounts transparently
 * through the `Address` type.
 *
 * @param config.address - The multisig source account address.
 * @param config.signers - Array of signers that each independently sign the tx.
 * @param config.threshold - Optional minimum number of signatures required
 *   (defaults to `signers.length`, i.e. all must sign).
 *
 * @example
 * ```ts
 * const adapter = await createMultisigAdapter({
 *   address: "GCA...MULTISIG_ADDRESS",
 *   signers: [
 *     await createFreighterAdapter(),
 *     {
 *       async signTransaction(xdr, network) {
 *         const keypair = Keypair.fromSecret(process.env.SIGNER_2_SECRET!);
 *         const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
 *         tx.sign(keypair);
 *         return tx.toEnvelope().toXDR("base64");
 *       },
 *     },
 *   ],
 *   threshold: 2,
 * });
 * ```
 */
/**
 * Creates a {@link WalletAdapter} that presents the recipient's address to the
 * contract but signs transactions with a separate claim-bot key.
 *
 * The bot key must be a co-signer on the recipient's Stellar account (classic
 * multisig) so that Soroban's `require_auth` accepts its signature for `withdraw`.
 *
 * This enables automated claiming daemons that never hold the recipient's primary
 * secret key. See {@link ClaimDelegateConfig} for the full setup guide.
 */
export function createClaimDelegateAdapter(config: ClaimDelegateConfig): WalletAdapter {
  return {
    async isConnected(): Promise<boolean> {
      return true;
    },

    async getPublicKey(): Promise<string> {
      return config.recipientAddress;
    },

    async signTransaction(xdr: string, network: Network): Promise<string> {
      return config.claimBotSigner.signTransaction(xdr, network);
    },
  };
}

export async function createMultisigAdapter(config: {
  address: string;
  signers: MultisigSigner[];
  threshold?: number;
}): Promise<WalletAdapter> {
  const threshold = config.threshold ?? config.signers.length;

  return {
    async isConnected(): Promise<boolean> {
      return true;
    },

    async getPublicKey(): Promise<string> {
      return config.address;
    },

    async signTransaction(xdr: string, network: Network): Promise<string> {
      const passphrase = NETWORK_PASSPHRASES[network];

      let combined: ReturnType<typeof TransactionBuilder.fromXDR> | null = null;
      let collected = 0;
      const seen = new Set<string>();

      for (const signer of config.signers) {
        if (collected >= threshold) break;

        const signedXdr = await signer.signTransaction(xdr, network);
        const tx = TransactionBuilder.fromXDR(signedXdr, passphrase);

        for (const sig of tx.signatures) {
          const key = sig.hint().toString("base64") + sig.signature().toString("base64");
          if (!seen.has(key)) {
            seen.add(key);
            if (!combined) {
              combined = TransactionBuilder.fromXDR(xdr, passphrase);
            }
            combined.signatures.push(sig);
            collected++;
          }
        }
      }

      if (!combined) {
        throw new Error("No signatures were collected");
      }

      return combined.toEnvelope().toXDR("base64");
    },
  };
}

/**
 * Configuration for the Ledger wallet adapter.
 */
export interface LedgerAdapterConfig {
  /** The Ledger transport instance (e.g. WebHID, WebUSB, NodeHID). */
  transport: any;
  /** BIP32 derivation path. Defaults to "44'/148'/0'". */
  path?: string;
}

/**
 * Creates a WalletAdapter backed by a Ledger hardware device using the Stellar Ledger app.
 *
 * @param config - The transport and derivation path.
 */
export function createLedgerAdapter(config: LedgerAdapterConfig): WalletAdapter {
  const path = config.path ?? "44'/148'/0'";
  const StrClass = require("@ledgerhq/hw-app-str").default || require("@ledgerhq/hw-app-str");
  const str = new StrClass(config.transport);
  let publicKey: string | null = null;

  return {
    async isConnected(): Promise<boolean> {
      try {
        const pk = await this.getPublicKey();
        return !!pk;
      } catch {
        return false;
      }
    },

    async getPublicKey(): Promise<string> {
      if (publicKey) return publicKey;
      const result = await str.getPublicKey(path);
      publicKey = result.publicKey;
      return result.publicKey;
    },

    async signTransaction(xdr: string, network: Network): Promise<string> {
      const passphrase = NETWORK_PASSPHRASES[network];
      const tx = TransactionBuilder.fromXDR(xdr, passphrase);
      const txHash = tx.hash();
      const result = await str.signHash(path, txHash);
      const pk = await this.getPublicKey();
      tx.addSignature(pk, result.signature.toString("base64"));
      return tx.toEnvelope().toXDR("base64");
    },
  };
}
