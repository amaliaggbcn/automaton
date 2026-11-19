/**
 * Conway Inference Client
 *
 * Wraps Conway's /v1/chat/completions endpoint (OpenAI-compatible)
 * and supports direct provider routing (OpenAI, Anthropic, Ollama).
 */

import type {
  InferenceClient,
  ChatMessage,
  InferenceOptions,
  InferenceResponse,
  InferenceToolCall,
  TokenUsage,
  InferenceToolDefinition,
} from "../types.js";
import { ResilientHttpClient } from "./http-client.js";

const INFERENCE_TIMEOUT_MS = 60_000;

interface InferenceClientOptions {
  apiUrl: string;
  apiKey: string;
  defaultModel: string;
  maxTokens: number;
  lowComputeModel?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  ollamaBaseUrl?: string;
  /** Optional registry lookup — if provided, used before name heuristics */
  getModelProvider?: (modelId: string) => string | undefined;
}

type InferenceBackend = "conway" | "openai" | "anthropic" | "ollama";

function isLoopbackHttpUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return (
      parsed.protocol.toLowerCase() === "http:" &&
      (host === "localhost" || host === "127.0.0.1" || host === "::1")
    );
  } catch {
    return false;
  }
}

export function createInferenceClient(
  options: InferenceClientOptions,
): InferenceClient {
  const {
    apiUrl,
    apiKey,
    openaiApiKey,
    anthropicApiKey,
    ollamaBaseUrl,
    getModelProvider,
  } = options;
  const httpClient = new ResilientHttpClient({
    baseTimeout: INFERENCE_TIMEOUT_MS,
    retryableStatuses: [429, 500, 502, 503, 504],
    allowHttpOnLoopback: isLoopbackHttpUrl(ollamaBaseUrl),
  });
  let currentModel = options.defaultModel;
  let maxTokens = options.maxTokens;

  const chat = async (
    messages: ChatMessage[],
    opts?: InferenceOptions,
  ): Promise<InferenceResponse> => {
    const model = opts?.model || currentModel;
    const tools = opts?.tools;

    const backend = resolveInferenceBackend(model, {
      openaiApiKey,
      anthropicApiKey,
      ollamaBaseUrl,
      getModelProvider,
    });

    const usesCompletionTokens =
      backend !== "ollama" && /^(o[1-9]|gpt-5|gpt-4\.1)/.test(model);
    const tokenLimit = opts?.maxTokens || maxTokens;

    const body: Record<string, unknown> = {
      model,
      messages: messages.map(formatMessage),
      stream: false,
    };

    if (usesCompletionTokens) {
      body.max_completion_tokens = tokenLimit;
    } else {
      body.max_tokens = tokenLimit;
    }

    if (opts?.temperature !== undefined) {
      body.temperature = opts.temperature;
    }

    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    if (backend === "anthropic") {
      return chatViaAnthropic({
        model,
        tokenLimit,
        messages,
        tools,
        temperature: opts?.temperature,
        anthropicApiKey: anthropicApiKey as string,
        httpClient,
      });
    }

    const openAiLikeApiUrl =
      backend === "openai"
        ? "https://api.openai.com"
        : backend === "ollama"
          ? (ollamaBaseUrl as string).replace(/\/\$/, "")
          : apiUrl;
    const openAiLikeApiKey =
      backend === "openai"
        ? (openaiApiKey as string)
        : backend === "ollama"
          ? "ollama"
          : apiKey;

    return chatViaOpenAiCompatible({
      model,
      body,
      apiUrl: openAiLikeApiUrl,
      apiKey: openAiLikeApiKey,
      backend,
      httpClient,
    });
  };

  const setLowComputeMode = (enabled: boolean): void => {
    if (enabled) {
      currentModel = options.lowComputeModel || "gpt-5-mini";
      maxTokens = 4096;
    } else {
      currentModel = options.defaultModel;
      maxTokens = options.maxTokens;
    }
  };

  const getDefaultModel = (): string => {
    return currentModel;
  };

  return {
    chat,
    setLowComputeMode,
    getDefaultModel,
  };
}

function formatMessage(msg: ChatMessage): Record<string, unknown> {
  const formatted: Record<string, unknown> = {
    role: msg.role,
    content: msg.content,
  };

  if (msg.name) formatted.name = msg.name;
  if (msg.tool_calls) formatted.tool_calls = msg.tool_calls;
  if (msg.tool_call_id) formatted.tool_call_id = msg.tool_call_id;

  return formatted;
}

function resolveInferenceBackend(
  model: string,
  keys: {
    openaiApiKey?: string;
    anthropicApiKey?: string;
    ollamaBaseUrl?: string;
    getModelProvider?: (modelId: string) => string | undefined;
  },
): InferenceBackend {
  // Priorizar claves directas antes que Conway
  if (keys.anthropicApiKey && /^claude/i.test(model)) return "anthropic";
  if (
    keys.openaiApiKey &&
    /^(gpt-[3-9]|gpt-4|gpt-5|o[1-9][-\s.]|o[1-9]\$|chatgpt)/i.test(model)
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

async function chatViaOpenAiCompatible(params: {
  model: string;
  body: Record<string, unknown>;
  apiUrl: string;
  apiKey: string;
  backend: "conway" | "openai" | "ollama";
  httpClient: ResilientHttpClient;
}): Promise<InferenceResponse> {
  const resp = await params.httpClient.request(
    `${params.apiUrl}/v1/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization:
          params.backend === "openai" || params.backend === "ollama"
            ? `Bearer ${params.apiKey}`
            : params.apiKey,
      },
      body: JSON.stringify(params.body),
      timeout: INFERENCE_TIMEOUT_MS,
    },
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Inference error (${params.backend}): ${resp.status}: ${text}`,
    );
  }

  const data = (await resp.json()) as any;
  const choice = data.choices?.[0];

  if (!choice) {
    throw new Error("No completion choice returned from inference");
  }

  const message = choice.message;
  const usage: TokenUsage = {
    promptTokens: data.usage?.prompt_tokens || 0,
    completionTokens: data.usage?.completion_tokens || 0,
    totalTokens: data.usage?.total_tokens || 0,
  };

  const toolCalls: InferenceToolCall[] | undefined = message.tool_calls?.map(
    (tc: any) => ({
      id: tc.id,
      type: "function" as const,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }),
  );

  return {
    id: data.id || "",
    model: data.model || params.model,
    message: {
      role: message.role,
      content: message.content || "",
      tool_calls: toolCalls,
    },
    toolCalls,
    usage,
    finishReason: choice.finish_reason || "stop",
  };
}

async function chatViaAnthropic(params: {
  model: string;
  tokenLimit: number;
  messages: ChatMessage[];
  tools?: InferenceToolDefinition[];
  temperature?: number;
  anthropicApiKey: string;
  httpClient: ResilientHttpClient;
}): Promise<InferenceResponse> {
  const transformed = transformMessagesForAnthropic(params.messages);
  const body: Record<string, unknown> = {
    model: params.model,
    max_tokens: params.tokenLimit,
    messages:
      transformed.messages.length > 0
        ? transformed.messages
        : (() => {
            throw new Error("Cannot send empty message array to Anthropic API");
          })(),
  };

  if (transformed.system) {
    body.system = transformed.system;
  }

  if (params.temperature !== undefined) {
    body.temperature = params.temperature;
  }

  if (params.tools && params.tools.length > 0) {
    body.tools = params.tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }));
    body.tool_choice = { type: "auto" };
  }

  const resp = await params.httpClient.request(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": params.anthropicApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      timeout: INFERENCE_TIMEOUT_MS,
    },
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Inference error (anthropic): ${resp.status}: ${text}`);
  }

  const data = (await resp.json()) as any;
  const content = Array.isArray(data.content) ? data.content : [];
  const textBlocks = content.filter((c: any) => c?.type === "text");
  const toolUseBlocks = content.filter((c: any) => c?.type === "tool_use");

  const toolCalls: InferenceToolCall[] | undefined =
    toolUseBlocks.length > 0
      ? toolUseBlocks.map((tool: any) => ({
          id: tool.id,
          type: "function" as const,
          function: {
            name: tool.name,
            arguments: JSON.stringify(tool.input || {}),
          },
        }))
      : undefined;

  const textContent = textBlocks
    .map((block: any) => String(block.text || ""))
    .join("\n")
    .trim();

  if (!textContent
