export type WorkerJobType = "push" | "pull_request";

interface BaseWorkerJob {
  v: 1;
  type: WorkerJobType;
  installationId: number;
  owner: string;
  repo: string;
  senderType?: string;
}

export interface PushWorkerJob extends BaseWorkerJob {
  type: "push";
  branch: string;
}

export interface PullRequestWorkerJob extends BaseWorkerJob {
  type: "pull_request";
  action: "opened" | "edited" | "synchronize";
  pullNumber: number;
}

export type WorkerJob = PushWorkerJob | PullRequestWorkerJob;
