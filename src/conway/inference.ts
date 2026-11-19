import type {
  InferenceClient,
  ChatMessage,
  InferenceOptions,
  InferenceResponse,
} from "../types.js";
import { ResilientHttpClient } from "./http-client.js";

export type InferenceBackend = "conway" | "openai" | "anthropic" | "ollama";

export interface InferenceClientOptions {
  apiUrl: string;
  apiKey: string;
  defaultModel: string;
  maxTokens: number;
  lowComputeModel?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  ollamaBaseUrl?: string;
  getModelProvider?: (modelId: string) => string | undefined;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function parseRetryAfterMs(errBody: string): number {
  const match = errBody.match(/try again in\s+([\d.]+)\s*s/i);
  if (match) {
    const seconds = Number.parseFloat(match[1]);
    if (!Number.isNaN(seconds) && seconds > 0) {
      return Math.min(Math.ceil(seconds * 1000) + 500, 65_000);
    }
  }
  return 12_000;
}

export function resolveInferenceBackend(
  model: string,
  keys: {
    openaiApiKey?: string;
    anthropicApiKey?: string;
    ollamaBaseUrl?: string;
    getModelProvider?: (modelId: string) => string | undefined;
  },
): InferenceBackend {
  if (keys.anthropicApiKey && /^claude/i.test(model)) {
    return "anthropic";
  }
  if (
    keys.openaiApiKey &&
    /^(gpt-[3-9]|gpt-4|gpt-5|o[1-9][-\s.]|o[1-9]$|chatgpt)/i.test(model)
  ) {
    return "openai";
  }

  if (keys.getModelProvider) {
    const provider = keys.getModelProvider(model);
    if (provider === "ollama" && keys.ollamaBaseUrl) return "ollama";
    if (provider === "anthropic" && keys.anthropicApiKey) return "anthropic";
    if (provider === "openai" && keys.openaiApiKey) return "openai";
    if (provider === "conway" && keys.openaiApiKey) return "openai";
    if (provider === "conway") return "conway";
  }

  return keys.openaiApiKey ? "openai" : "conway";
}

export function createInferenceClient(
  options: InferenceClientOptions,
): InferenceClient {
  const httpClient = new ResilientHttpClient({
    baseTimeout: 60_000,
    retryableStatuses: [500, 502, 503, 504],
  });

  const envModel = process.env.OPENAI_MODEL?.trim();
  const forceEnvModel =
    process.env.OPENAI_FORCE_MODEL?.trim().toLowerCase() === "true";
  const stripTools =
    process.env.OPENAI_STRIP_TOOLS?.trim().toLowerCase() === "true";

  const preferredModel =
    envModel ||
    options.defaultModel ||
    (options.openaiApiKey ? "gpt-4o-mini" : "gpt-5.2");

  const lowComputeTarget =
    process.env.OPENAI_LOW_COMPUTE_MODEL?.trim() ||
    options.lowComputeModel ||
    "gpt-4o-mini";

  let activeModel = preferredModel;
  let activeMaxTokens = Math.min(options.maxTokens || 2048, 2048);
  let lowComputeEnabled = false;

  const chat = async (
    messages: ChatMessage[],
    opts?: InferenceOptions,
  ): Promise<InferenceResponse> => {
    // Si OPENAI_FORCE_MODEL=true y hay OPENAI_MODEL, o si lowComputeEnabled está activo,
    // prioriza activeModel para evitar que el router fuerce gpt-5.2 en cada turno.
    const model =
      (forceEnvModel && envModel) || lowComputeEnabled
        ? activeModel
        : opts?.model || activeModel;

    const maxTokens = Math.min(opts?.maxTokens || activeMaxTokens, 2048);
    const backend = resolveInferenceBackend(model, {
      openaiApiKey: options.openaiApiKey,
      anthropicApiKey: options.anthropicApiKey,
      ollamaBaseUrl: options.ollamaBaseUrl,
      getModelProvider: options.getModelProvider,
    });

    const baseUrl =
      backend === "openai"
        ? "https://api.openai.com"
        : backend === "ollama" && options.ollamaBaseUrl
          ? options.ollamaBaseUrl.replace(/\/$/, "")
          : options.apiUrl;

    const tokenKey =
      backend !== "ollama" && /^(o[1-9]|gpt-5|gpt-4\.1)/.test(model)
        ? "max_completion_tokens"
        : "max_tokens";

    const payload: Record<string, unknown> = {
      model,
      messages,
      stream: false,
      [tokenKey]: maxTokens,
    };

    if (opts?.temperature !== undefined) {
      payload.temperature = opts.temperature;
    }
    if (!stripTools && opts?.tools && opts.tools.length > 0) {
      payload.tools = opts.tools;
      payload.tool_choice = "auto";
    }

    const authHeader =
      backend === "openai" || backend === "ollama"
        ? `Bearer ${backend === "openai" ? options.openaiApiKey : "ollama"}`
        : options.apiKey;

    const maxRateLimitRetries = 2;
    let attempt = 0;

    while (true) {
      const res = await httpClient.request(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader || "",
        },
        body: JSON.stringify(payload),
        timeout: 60_000,
      });

      if (res.ok) {
        const json = (await res.json()) as any;
        const choice = json.choices?.[0];
        if (!choice?.message) {
          throw new Error("Empty inference response");
        }

        return {
          id: json.id || "",
          model: json.model || model,
          message: {
            role: choice.message.role || "assistant",
            content: choice.message.content || "",
            tool_calls: choice.message.tool_calls,
          },
          toolCalls: choice.message.tool_calls,
          usage: {
            promptTokens: json.usage?.prompt_tokens || 0,
            completionTokens: json.usage?.completion_tokens || 0,
            totalTokens: json.usage?.total_tokens || 0,
          },
          finishReason: choice.finish_reason || "stop",
        };
      }

      const errBody = await res.text();
      if (res.status === 429 && attempt < maxRateLimitRetries) {
        attempt += 1;
        const waitMs = parseRetryAfterMs(errBody);
        await sleep(waitMs);
        continue;
      }

      throw new Error(`Inference request failed (${res.status}): ${errBody}`);
    }
  };

  const setLowComputeMode = (enabled: boolean): void => {
    lowComputeEnabled = enabled;
    if (enabled) {
      activeModel = lowComputeTarget;
      activeMaxTokens = 1500;
    } else {
      activeModel = preferredModel;
      activeMaxTokens = Math.min(options.maxTokens || 2048, 2048);
    }
  };

  const getDefaultModel = (): string => activeModel;

  return {
    chat,
    setLowComputeMode,
    getDefaultModel,
  };
}
