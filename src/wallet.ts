import type { WalletAdapter, Network } from "./types.js";
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { TransactionBuilder } from "@stellar/stellar-sdk";
import type { WalletAdapter, Network, MultisigSigner } from "./types.js";

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
