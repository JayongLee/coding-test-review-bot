import { Probot } from "probot";
import { enqueueWorkerJob } from "./queue.js";

export default (app: Probot): void => {
  app.on("push", async (context) => {
    if (context.payload.sender?.type === "Bot") return;
    if (!context.payload.ref.startsWith("refs/heads/")) return;
    if (!context.payload.installation?.id) return;

    const [owner, repo] = context.payload.repository.full_name.split("/");
    const branch = context.payload.ref.replace("refs/heads/", "");

    try {
      await enqueueWorkerJob({
        v: 1,
        type: "push",
        installationId: context.payload.installation.id,
        owner,
        repo,
        branch,
        senderType: context.payload.sender?.type
      });
    } catch (error) {
      context.log.error(error, "Failed to enqueue push worker job");
      throw error;
    }
  });

  app.on(["pull_request.opened", "pull_request.edited", "pull_request.synchronize"], async (context) => {
    if (context.payload.sender?.type === "Bot") return;
    if (!context.payload.installation?.id) return;

    try {
      await enqueueWorkerJob({
        v: 1,
        type: "pull_request",
        action: context.payload.action,
        installationId: context.payload.installation.id,
        owner: context.payload.repository.owner.login,
        repo: context.payload.repository.name,
        pullNumber: context.payload.pull_request.number,
        senderType: context.payload.sender?.type
      });
    } catch (error) {
      context.log.error(error, "Failed to enqueue pull_request worker job");
      throw error;
    }
  });
};
