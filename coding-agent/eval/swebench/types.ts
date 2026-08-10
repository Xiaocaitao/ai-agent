export type SWEbenchWorkerInput = {
  taskId: string;
  problemStatement: string;
};

export type SWEbenchWorkerResult = {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
};
