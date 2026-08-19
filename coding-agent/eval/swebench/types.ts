export type SWEbenchWorkerInput = {
  taskId: string; // 任务唯一编号
  problemStatement: string; // 问题描述
};

export type SWEbenchWorkerResult = {
  exitCode: number | null; // 退出码
  timedOut: boolean; // 是否超时
  stdout: string; // worker的正常输出
  stderr: string;
};
