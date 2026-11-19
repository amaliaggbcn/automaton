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
    retryableStatuses: [429, 500, 502, 503, 504],
  });

  let activeModel = options.defaultModel;
  let activeMaxTokens = options.maxTokens;

  const chat = async (
    messages: ChatMessage[],
    opts?: InferenceOptions,
  ): Promise<InferenceResponse> => {
    const model = opts?.model || activeModel;
    const maxTokens = opts?.maxTokens || activeMaxTokens;
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
    if (opts?.tools && opts.tools.length > 0) {
      payload.tools = opts.tools;
      payload.tool_choice = "auto";
    }

    const authHeader =
      backend === "openai" || backend === "ollama"
        ? `Bearer ${backend === "openai" ? options.openaiApiKey : "ollama"}`
        : options.apiKey;

    const res = await httpClient.request(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader || "",
      },
      body: JSON.stringify(payload),
      timeout: 60_000,
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Inference request failed (${res.status}): ${errBody}`);
    }

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
  };

  const setLowComputeMode = (enabled: boolean): void => {
    if (enabled) {
      activeModel = options.lowComputeModel || "gpt-5-mini";
      activeMaxTokens = 4096;
    } else {
      activeModel = options.defaultModel;
      activeMaxTokens = options.maxTokens;
    }
  };

  const getDefaultModel = (): string => activeModel;

  return {
    chat,
    setLowComputeMode,
    getDefaultModel,
  };
}
