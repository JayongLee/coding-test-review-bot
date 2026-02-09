import { createHash } from "node:crypto";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import type { WorkerJob } from "./jobs.js";

const sqs = new SQSClient({});

function makeDeduplicationId(job: WorkerJob): string {
  return createHash("sha256").update(JSON.stringify(job)).digest("hex");
}

export async function enqueueWorkerJob(job: WorkerJob): Promise<void> {
  const queueUrl = process.env.WEBHOOK_QUEUE_URL;
  if (!queueUrl) {
    throw new Error("WEBHOOK_QUEUE_URL is required.");
  }

  const params: ConstructorParameters<typeof SendMessageCommand>[0] = {
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify(job)
  };

  if (queueUrl.endsWith(".fifo")) {
    params.MessageGroupId = `${job.owner}/${job.repo}`;
    params.MessageDeduplicationId = makeDeduplicationId(job);
  }

  await sqs.send(new SendMessageCommand(params));
}
