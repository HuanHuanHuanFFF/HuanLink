// RunViewReader 只负责按 runId 读取派生视图，不暴露底层存储细节。
import type {RunId} from "../shared/ids.js";
import type {RunView} from "./types.js";

// 最小 RunView 读取边界，供不同存储实现复用。
export type RunViewReader = {
    readRunView(runId: RunId): Promise<RunView | null> | RunView | null;
};
