// Runs the Next.js CLI with the monorepo-root .env.local loaded first.
// (A node --env-file flag can't be used: `next dev` forwards flags through
// NODE_OPTIONS, which rejects it.) Variables already set, e.g. by Vercel,
// are not overridden. On Vercel the file does not exist and this is a no-op.
import { existsSync } from "node:fs";

const envFile = new URL("../../.env.local", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

await import(new URL("../node_modules/next/dist/bin/next", import.meta.url).href);
