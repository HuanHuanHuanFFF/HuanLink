export const TASK_EXECUTION_MODES = ["async", "blocking"] as const;

export type TaskExecutionMode = (typeof TASK_EXECUTION_MODES)[number];
