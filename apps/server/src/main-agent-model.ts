import {
  createDeepSeek,
  type DeepSeekProviderSettings,
} from "@ai-sdk/deepseek";
import { aisdk } from "@openai/agents-extensions/ai-sdk";
import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";

import type { MainAgentModelBinding } from "./main-agent-runtime.js";

export type MainAgentModelConfig = {
  provider: "deepseek";
  modelId: string;
  baseURL: string;
  apiKey: string;
};

export type CreateDeepSeekMainAgentModelBindingOptions = {
  config: MainAgentModelConfig;
  fetch?: DeepSeekProviderSettings["fetch"];
};

const deepSeekToolMessageMiddleware: LanguageModelMiddleware = {
  specificationVersion: "v3",
  transformParams: async ({ params }) => {
    const prompt: typeof params.prompt = [];
    for (const message of params.prompt) {
      const previous = prompt.at(-1);
      if (
        previous?.role === "assistant" &&
        message.role === "assistant" &&
        previous.content.some((part) => part.type === "tool-call")
      ) {
        // The bridge can split text and calls from one DeepSeek response.
        // Keep them together so matching tool results immediately follow it.
        prompt[prompt.length - 1] = {
          ...previous,
          content: [...previous.content, ...message.content],
          providerOptions: {
            ...previous.providerOptions,
            ...message.providerOptions,
          },
        };
      } else {
        prompt.push(message);
      }
    }
    return { ...params, prompt };
  },
};

export function createDeepSeekMainAgentModelBinding(
  options: CreateDeepSeekMainAgentModelBindingOptions,
): MainAgentModelBinding {
  const provider = createDeepSeek({
    apiKey: options.config.apiKey,
    baseURL: options.config.baseURL,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  return {
    model: aisdk(
      wrapLanguageModel({
        model: provider(options.config.modelId),
        middleware: deepSeekToolMessageMiddleware,
      }),
    ),
    modelSettings: {
      providerData: {
        providerOptions: {
          deepseek: {
            thinking: { type: "enabled" },
            reasoningEffort: "high",
          },
        },
      },
    },
  };
}
