import { createLambdaFunction, createProbot } from "@probot/adapter-aws-lambda-serverless";
import app from "./index.js";

if (!process.env.PRIVATE_KEY && process.env.PRIVATE_KEY_BASE64) {
  process.env.PRIVATE_KEY = Buffer.from(process.env.PRIVATE_KEY_BASE64, "base64").toString("utf-8");
}

const probot = createProbot();
const lambdaApp = app as unknown as Parameters<typeof createLambdaFunction>[0];

export const webhooks = createLambdaFunction(lambdaApp, { probot });
