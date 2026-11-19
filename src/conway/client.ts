/**
 * Conway API Client (Decoupled / Local Fallback Mode)
 *
 * Keeps local sandbox execution and returns safe defaults for
 * Conway-specific endpoints so the agent runs without a Conway account.
 */

import { execSync } from "child_process";
import fs from "fs";
import nodePath from "path";
import type {
  ConwayClient,
  ExecResult,
  PortInfo,
  CreateSandboxOptions,
  SandboxInfo,
  PricingTier,
  CreditTransferResult,
  DomainSearchResult,
  DomainRegistration,
  DnsRecord,
  ModelInfo,
} from "../types.js";
import type { PrivateKeyAccount } from "viem";
import type { ChainType, ChainIdentity } from "../identity/chain.js";

interface ConwayClientOptions {
  apiUrl: string;
  apiKey: string;
  sandboxId: string;
}

export function createConwayClient(options: ConwayClientOptions): ConwayClient {
  const { apiUrl, apiKey } = options;
  const sandboxId = normalizeSandboxId(options.sandboxId);

  // ─── Sandbox Operations (always local when decoupled from Conway) ────

  const execLocal = (command: string, timeout?: number): ExecResult => {
    try {
      const stdout = execSync(command, {
        timeout: timeout || 30_000,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
        cwd: process.env.HOME || "/root",
      });
      return { stdout: stdout || "", stderr: "", exitCode: 0 };
    } catch (err: any) {
      return {
        stdout: err.stdout || "",
        stderr: err.stderr || err.message || "",
        exitCode: err.status ?? 1,
      };
    }
  };

  const exec = async (
    command: string,
    timeout?: number,
  ): Promise<ExecResult> => {
    return execLocal(command, timeout);
  };

  const resolveLocalPath = (filePath: string): string =>
    filePath.startsWith("~")
      ? nodePath.join(process.env.HOME || "/root", filePath.slice(1))
      : filePath;

  const writeFile = async (
    filePath: string,
    content: string,
  ): Promise<void> => {
    const resolved = resolveLocalPath(filePath);
    const dir = nodePath.dirname(resolved);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(resolved, content, "utf-8");
  };

  const readFile = async (filePath: string): Promise<string> => {
    return fs.readFileSync(resolveLocalPath(filePath), "utf-8");
  };

  const exposePort = async (port: number): Promise<PortInfo> => {
    return {
      port,
      publicUrl: `http://localhost:${port}`,
      sandboxId: sandboxId || "local",
    };
  };

  const removePort = async (_port: number): Promise<void> => {
    // No-op in local mode
  };

  // ─── Sandbox Management (stubbed without Conway) ─────────────

  const createSandbox = async (
    opts: CreateSandboxOptions,
  ): Promise<SandboxInfo> => {
    return {
      id: "local-sandbox",
      status: "running",
      region: opts.region || "local",
      vcpu: opts.vcpu || 1,
      memoryMb: opts.memoryMb || 512,
      diskGb: opts.diskGb || 5,
      createdAt: new Date().toISOString(),
    };
  };

  const deleteSandbox = async (_targetId: string): Promise<void> => {
    // No-op
  };

  const listSandboxes = async (): Promise<SandboxInfo[]> => {
    return [];
  };

  // ─── Credits (mocked to avoid 401 from Conway) ───────────────

  const getCreditsBalance = async (): Promise<number> => {
    return 10000;
  };

  const getCreditsPricing = async (): Promise<PricingTier[]> => {
    return [];
  };

  const transferCredits = async (
    toAddress: string,
    amountCents: number,
  ): Promise<CreditTransferResult> => {
    return {
      transferId: "local-noop",
      status: "disabled",
      toAddress,
      amountCents,
    };
  };

  const registerAutomaton = async (params: {
    automatonId: string;
    automatonAddress: string;
    creatorAddress: string;
    name: string;
    bio?: string;
    genesisPromptHash?: `0x${string}`;
    account: PrivateKeyAccount;
    nonce?: string;
    chainType?: ChainType;
    chainIdentity?: ChainIdentity;
  }): Promise<{ automaton: Record<string, unknown> }> => {
    return {
      automaton: {
        automaton_id: params.automatonId,
        automaton_address: params.automatonAddress,
        creator_address: params.creatorAddress,
        name: params.name,
        bio: params.bio || "",
        status: "local",
      },
    };
  };

  // ─── Domains (stubbed without Conway) ────────────────────────

  const searchDomains = async (): Promise<DomainSearchResult[]> => {
    return [];
  };

  const registerDomain = async (
    domain: string,
  ): Promise<DomainRegistration> => {
    return {
      domain,
      status: "unavailable_without_conway",
    };
  };

  const listDnsRecords = async (): Promise<DnsRecord[]> => {
    return [];
  };

  const addDnsRecord = async (
    _domain: string,
    type: string,
    host: string,
    value: string,
    ttl?: number,
  ): Promise<DnsRecord> => {
    return {
      id: "local-noop",
      type,
      host,
      value,
      ttl: ttl || 3600,
    };
  };

  const deleteDnsRecord = async (): Promise<void> => {
    // No-op
  };

  // ─── Model Discovery ─────────────────────────────────────────

  const listModels = async (): Promise<ModelInfo[]> => {
    return [
      {
        id: "gpt-4o-mini",
        provider: "openai",
        pricing: {
          inputPerMillion: 0.15,
          outputPerMillion: 0.6,
        },
      },
      {
        id: "gpt-5-mini",
        provider: "openai",
        pricing: {
          inputPerMillion: 0.25,
          outputPerMillion: 2.0,
        },
      },
    ];
  };

  const createScopedClient = (targetSandboxId: string): ConwayClient => {
    return createConwayClient({ apiUrl, apiKey, sandboxId: targetSandboxId });
  };

  return {
    exec,
    writeFile,
    readFile,
    exposePort,
    removePort,
    createSandbox,
    deleteSandbox,
    listSandboxes,
    getCreditsBalance,
    getCreditsPricing,
    transferCredits,
    registerAutomaton,
    searchDomains,
    registerDomain,
    listDnsRecords,
    addDnsRecord,
    deleteDnsRecord,
    listModels,
    createScopedClient,
  };
}

function normalizeSandboxId(value: string | null | undefined): string {
  const trimmed = (value || "").trim();
  if (!trimmed) return "";
  if (trimmed === "undefined" || trimmed === "null") return "";
  return trimmed;
}
