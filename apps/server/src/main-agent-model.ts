import {
  createDeepSeek,
  type DeepSeekProviderSettings
} from "@ai-sdk/deepseek";
import { aisdk } from "@openai/agents-extensions/ai-sdk";
import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";

import type { MainAgentModelBinding } from "./main-agent-runtime.js";
import type { MainAgentModelConfig } from "./runtime-config.js";

export type CreateDeepSeekMainAgentModelBindingOptions = {
  config: MainAgentModelConfig;
  fetch?: DeepSeekProviderSettings["fetch"];
};

const strictFunctionToolsMiddleware: LanguageModelMiddleware = {
  specificationVersion: "v3",
  transformParams: async ({ params }) => ({
    ...params,
    ...(params.tools === undefined
      ? {}
      : {
          tools: params.tools.map((tool) =>
            tool.type === "function" ? { ...tool, strict: true } : tool
          )
        })
  })
};

export function createDeepSeekMainAgentModelBinding(
  options: CreateDeepSeekMainAgentModelBindingOptions
): MainAgentModelBinding {
  const provider = createDeepSeek({
    apiKey: options.config.apiKey,
    baseURL: options.config.baseURL,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch })
  });
  const model = wrapLanguageModel({
    model: provider(options.config.modelId),
    middleware: strictFunctionToolsMiddleware
  });

  return {
    model: aisdk(model),
    modelSettings: {
      providerData: {
        providerOptions: {
          deepseek: {
            thinking: { type: "enabled" },
            reasoningEffort: "high"
          }
        }
      }
    }
  };
}
