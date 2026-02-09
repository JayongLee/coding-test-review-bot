export function ensurePrivateKeyLoaded(): string {
  if (!process.env.PRIVATE_KEY && process.env.PRIVATE_KEY_BASE64) {
    process.env.PRIVATE_KEY = Buffer.from(process.env.PRIVATE_KEY_BASE64, "base64").toString("utf-8");
  }

  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("PRIVATE_KEY or PRIVATE_KEY_BASE64 is required.");
  }
  return privateKey;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}
