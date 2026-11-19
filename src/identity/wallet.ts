/**
 * Automaton Wallet Management
 *
 * Creates and manages wallets for the automaton's identity and payments.
 * Supports both EVM (secp256k1/viem) and Solana (Ed25519/tweetnacl) wallets.
 * The private key is the automaton's sovereign identity.
 * Chain type is chosen at genesis and never changes.
 */

import type { PrivateKeyAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import nacl from "tweetnacl";
import bs58 from "bs58";
import fs from "fs";
import path from "path";
import type { WalletData } from "../types.js";
import type { ChainType } from "./chain.js";
import { EvmChainIdentity, SolanaChainIdentity } from "./chain.js";
import type { ChainIdentity } from "./chain.js";

function createSolanaStubAccount(solanaAddress: string): PrivateKeyAccount {
  const throwSigning = () => {
    throw new Error(
      "Cannot use EVM signing methods on a Solana wallet. Use chainIdentity instead.",
    );
  };
  return {
    address: solanaAddress as any,
    publicKey: "0x" as any,
    source: "custom",
    type: "local",
    signMessage: throwSigning as any,
    signTypedData: throwSigning as any,
    signTransaction: throwSigning as any,
    sign: throwSigning as any,
  } as unknown as PrivateKeyAccount;
}

const AUTOMATON_DIR = path.join(
  process.env.HOME || "/root",
  ".automaton",
);
const WALLET_FILE = path.join(AUTOMATON_DIR, "wallet.json");

function getEnvPrivateKey(): `0x${string}` | null {
  const raw = (
    process.env.WALLET_PRIVATE_KEY ||
    process.env.PRIVATE_KEY ||
    ""
  ).trim();
  if (!raw) return null;
  const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;
  return normalized as `0x${string}`;
}

export function getAutomatonDir(): string {
  return AUTOMATON_DIR;
}

export function getWalletPath(): string {
  return WALLET_FILE;
}

export function generateSolanaKeypair(): {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  address: string;
} {
  const keypair = nacl.sign.keyPair();
  return {
    secretKey: keypair.secretKey,
    publicKey: keypair.publicKey,
    address: bs58.encode(keypair.publicKey),
  };
}

export async function getWallet(chainType?: ChainType): Promise<{
  account: PrivateKeyAccount;
  chainIdentity: ChainIdentity;
  chainType: ChainType;
  isNew: boolean;
}> {
  if (!fs.existsSync(AUTOMATON_DIR)) {
    fs.mkdirSync(AUTOMATON_DIR, { recursive: true, mode: 0o700 });
  }

  // 1. Priorizar clave privada fija por variable de entorno
  const envKey = getEnvPrivateKey();
  if (envKey) {
    const account = privateKeyToAccount(envKey);
    const walletData: WalletData = {
      chainType: "evm",
      privateKey: envKey,
      createdAt: new Date().toISOString(),
    };
    try {
      fs.writeFileSync(WALLET_FILE, JSON.stringify(walletData, null, 2), {
        mode: 0o600,
      });
    } catch {
      // Si el sistema de archivos es de solo lectura, continuamos en memoria con la clave del entorno
    }
    return {
      account,
      chainIdentity: new EvmChainIdentity(account),
      chainType: "evm",
      isNew: false,
    };
  }

  // 2. Si existe wallet.json en disco, cargarla
  if (fs.existsSync(WALLET_FILE)) {
    const walletData: WalletData = JSON.parse(
      fs.readFileSync(WALLET_FILE, "utf-8"),
    );
    const resolvedChainType = walletData.chainType || "evm";

    if (resolvedChainType === "solana" && walletData.secretKey) {
      const secretKey = bs58.decode(walletData.secretKey);
      const solanaIdentity = new SolanaChainIdentity(secretKey);
      const account = createSolanaStubAccount(solanaIdentity.address);
      return {
        account,
        chainIdentity: solanaIdentity,
        chainType: "solana",
        isNew: false,
      };
    }

    const account = privateKeyToAccount(walletData.privateKey!);
    return {
      account,
      chainIdentity: new EvmChainIdentity(account),
      chainType: "evm",
      isNew: false,
    };
  }

  // 3. Crear wallet nueva solo si no hay variable de entorno ni archivo previo
  const resolvedChain = chainType || "evm";

  if (resolvedChain === "solana") {
    const { secretKey, address } = generateSolanaKeypair();
    const solanaIdentity = new SolanaChainIdentity(secretKey);

    const walletData: WalletData = {
      chainType: "solana",
      secretKey: bs58.encode(secretKey),
      createdAt: new Date().toISOString(),
    };

    fs.writeFileSync(WALLET_FILE, JSON.stringify(walletData, null, 2), {
      mode: 0o600,
    });

    const account = createSolanaStubAccount(address);
    return {
      account,
      chainIdentity: solanaIdentity,
      chainType: "solana",
      isNew: true,
    };
  }

  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);

  const walletData: WalletData = {
    chainType: "evm",
    privateKey,
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync(WALLET_FILE, JSON.stringify(walletData, null, 2), {
    mode: 0o600,
  });

  return {
    account,
    chainIdentity: new EvmChainIdentity(account),
    chainType: "evm",
    isNew: true,
  };
}

export function getWalletAddress(): string | null {
  const envKey = getEnvPrivateKey();
  if (envKey) {
    return privateKeyToAccount(envKey).address;
  }

  if (!fs.existsSync(WALLET_FILE)) {
    return null;
  }

  const walletData: WalletData = JSON.parse(
    fs.readFileSync(WALLET_FILE, "utf-8"),
  );

  if (walletData.chainType === "solana" && walletData.secretKey) {
    const secretKey = bs58.decode(walletData.secretKey);
    const keypair = nacl.sign.keyPair.fromSecretKey(secretKey);
    return bs58.encode(keypair.publicKey);
  }

  const account = privateKeyToAccount(walletData.privateKey!);
  return account.address;
}

export function loadWalletAccount(): PrivateKeyAccount | null {
  const envKey = getEnvPrivateKey();
  if (envKey) {
    return privateKeyToAccount(envKey);
  }

  if (!fs.existsSync(WALLET_FILE)) {
    return null;
  }

  const walletData: WalletData = JSON.parse(
    fs.readFileSync(WALLET_FILE, "utf-8"),
  );

  if (walletData.chainType === "solana") {
    return null;
  }

  return privateKeyToAccount(walletData.privateKey!);
}

export function getWalletChainType(): ChainType {
  if (getEnvPrivateKey()) {
    return "evm";
  }
  if (!fs.existsSync(WALLET_FILE)) {
    return "evm";
  }
  try {
    const walletData: WalletData = JSON.parse(
      fs.readFileSync(WALLET_FILE, "utf-8"),
    );
    return walletData.chainType || "evm";
  } catch {
    return "evm";
  }
}

export function walletExists(): boolean {
  return Boolean(getEnvPrivateKey()) || fs.existsSync(WALLET_FILE);
}
