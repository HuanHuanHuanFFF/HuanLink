import type { Message } from "@a2a-js/sdk";
import { RequestMalformedError } from "@a2a-js/sdk/errors";
import { z } from "zod";
import type { CodexModelCapability } from "./codex-app-server-client.js";
import type { CodexAdapterLocalConfig } from "./runtime-config.js";

export type CodexProject = CodexAdapterLocalConfig["projects"][number];
export type ResolvedCodexDispatch = {
  project: CodexProject;
  modelId: string;
  reasoningEffort: string;
};

const dispatchSchema = z
  .object({
    type: z.literal("huanlink.codex-task.v1"),
    projectId: z.string().min(1),
    modelId: z.string().min(1).optional(),
    reasoningEffort: z.string().min(1).optional(),
  })
  .strict();

export class CodexDispatchPolicy {
  private readonly projects: Map<string, CodexProject>;
  private readonly models: Map<string, ReadonlySet<string>>;

  constructor(
    projects: readonly CodexProject[],
    models: readonly CodexModelCapability[],
  ) {
    this.projects = new Map(
      projects.map((project) => [project.projectId, { ...project }]),
    );
    if (!projects.length || this.projects.size !== projects.length)
      throw new Error("Invalid Codex project registry");
    this.models = new Map(
      models.map((model) => [model.model, new Set(model.reasoningEfforts)]),
    );
    for (const project of projects)
      this.validateModel(
        project.defaultModelId,
        project.defaultReasoningEffort,
      );
  }

  resolve(message: Message): ResolvedCodexDispatch {
    const parts = message.parts.filter(
      (part) => part.content?.$case === "data",
    );
    const parsed =
      parts.length === 1 && parts[0]?.content?.$case === "data"
        ? dispatchSchema.safeParse(parts[0].content.value)
        : undefined;
    if (!parsed?.success)
      throw new RequestMalformedError(
        "HUANLINK_PREACCEPT_REJECTED: Codex dispatch requires one structured project/options part",
      );
    if (
      !message.parts.some(
        (part) => part.content?.$case === "text" && part.content.value.trim(),
      )
    ) {
      throw new RequestMalformedError(
        "HUANLINK_PREACCEPT_REJECTED: Codex dispatch requires task text",
      );
    }
    const project = this.projects.get(parsed.data.projectId);
    if (!project)
      throw new RequestMalformedError(
        "HUANLINK_PREACCEPT_REJECTED: Unknown Codex projectId",
      );
    const modelId = parsed.data.modelId ?? project.defaultModelId;
    const reasoningEffort =
      parsed.data.reasoningEffort ?? project.defaultReasoningEffort;
    this.validateModel(modelId, reasoningEffort);
    return { project: { ...project }, modelId, reasoningEffort };
  }

  private validateModel(modelId: string, effort: string): void {
    if (!this.models.get(modelId)?.has(effort))
      throw new RequestMalformedError(
        "HUANLINK_PREACCEPT_REJECTED: Unsupported Codex model or reasoning effort",
      );
  }
}
