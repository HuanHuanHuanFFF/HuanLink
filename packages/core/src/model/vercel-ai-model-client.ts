import {generateText, streamText} from "ai";
import type {LanguageModel, ToolSet} from "ai";

import type {
    ModelClient,
    ModelResponse,
    ModelStreamEvent,
    StreamingModelClient
} from "./types.js";
import {
    toModelResponse,
    toModelStreamEvent,
    toVercelAiPrompt
} from "./vercel-ai-message-mapper.js";

// 直接从 AI SDK 的公开调用面推导类型，避免在本地重复声明请求/结果结构。
type GenerateTextRequest = Parameters<typeof generateText>[0];
type GenerateTextResult = Pick<
    Awaited<ReturnType<typeof generateText>>,
    "responseMessages"
>;
type StreamTextRequest = Parameters<typeof streamText>[0];
type StreamTextResult = Pick<
    ReturnType<typeof streamText>,
    "stream" | "responseMessages"
>;

type VercelAiModelClientDeps = {
    generateText?: (input: GenerateTextRequest) => Promise<GenerateTextResult>;
    streamText?: (input: StreamTextRequest) => StreamTextResult;
};

export type VercelAiModelClientConfig = {
    model: LanguageModel;
    tools?: ToolSet;
    maxOutputTokens?: number;
    temperature?: number;
};

export class VercelAiModelClient implements StreamingModelClient {
    private readonly model: LanguageModel;
    private readonly tools?: ToolSet;
    private readonly maxOutputTokens?: number;
    private readonly temperature?: number;
    private readonly generateTextImpl: (
        input: GenerateTextRequest
    ) => Promise<GenerateTextResult>;
    private readonly streamTextImpl: (input: StreamTextRequest) => StreamTextResult;

    constructor(
        config: VercelAiModelClientConfig,
        deps: VercelAiModelClientDeps = {}
    ) {
        this.model = config.model;
        this.tools = config.tools;
        this.maxOutputTokens = config.maxOutputTokens;
        this.temperature = config.temperature;
        this.generateTextImpl =
            deps.generateText ?? generateText;
        this.streamTextImpl = deps.streamText ?? streamText;
    }

    async complete(
        input: Parameters<ModelClient["complete"]>[0]
    ): Promise<ModelResponse> {
        const prompt = toVercelAiPrompt(input.messages);
        const result = await this.generateTextImpl({
            model: this.model,
            system: prompt.system,
            messages: prompt.messages,
            tools: toDeclarativeToolSet(this.tools),
            maxOutputTokens: this.maxOutputTokens,
            temperature: this.temperature,
            abortSignal: input.signal
        });

        return toModelResponse(result.responseMessages);
    }

    stream(
        input: Parameters<StreamingModelClient["stream"]>[0]
    ): AsyncIterable<ModelStreamEvent> {
        const prompt = toVercelAiPrompt(input.messages);
        const result = this.streamTextImpl({
            model: this.model,
            system: prompt.system,
            messages: prompt.messages,
            tools: toDeclarativeToolSet(this.tools),
            maxOutputTokens: this.maxOutputTokens,
            temperature: this.temperature,
            abortSignal: input.signal
        });

        return this.consumeStream(result);
    }

    private async* consumeStream(
        result: StreamTextResult
    ): AsyncIterable<ModelStreamEvent> {
        // Huaness 只保留自己的最小流事件协议，其余 AI SDK 事件在这里统一忽略。
        for await (const part of result.stream) {
            const event = toModelStreamEvent(part);

            if (event) {
                yield event;
            }
        }

        yield {
            type: "finish",
            response: toModelResponse(await result.responseMessages)
        };
    }
}

function toDeclarativeToolSet(tools?: ToolSet): ToolSet | undefined {
    if (tools == null) {
        return undefined;
    }

    const declarativeTools: ToolSet = {};

    for (const [name, tool] of Object.entries(tools)) {
        // 这里只向模型暴露 schema/description 这类声明性信息；
        // 真正的工具执行必须留在 AgentLoop -> ToolGateway 这一侧。
        declarativeTools[name] = {
            ...tool,
            execute: undefined,
            needsApproval: undefined,
            onInputAvailable: undefined,
            onInputStart: undefined,
            onInputDelta: undefined
        };
    }

    return declarativeTools;
}
