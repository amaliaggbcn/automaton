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

  const getCredits
