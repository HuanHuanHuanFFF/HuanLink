export const TASK_EXECUTION_MODES = ["background", "wait"] as const;

export type TaskExecutionMode = (typeof TASK_EXECUTION_MODES)[number];
