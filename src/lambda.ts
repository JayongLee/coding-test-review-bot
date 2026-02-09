import adapter from "@probot/adapter-aws-lambda-serverless";
import { ensurePrivateKeyLoaded } from "./env.js";
import app from "./index.js";

ensurePrivateKeyLoaded();

const { createLambdaFunction, createProbot } = adapter;
const probot = createProbot();
const lambdaApp = app as unknown as Parameters<typeof createLambdaFunction>[0];

export const webhooks = createLambdaFunction(lambdaApp, { probot });
