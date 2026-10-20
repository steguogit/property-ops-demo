// Loads env for standalone tsx scripts before any lib imports run.
// `.env` holds the shared/default config (e.g. the cloud Atlas string). An
// optional `.env.local` overrides it (e.g. to point scripts at a local Atlas
// deployment) — matching Next.js's .env.local precedence so the app and scripts
// stay in sync.
import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(process.cwd(), ".env") });
config({ path: resolve(process.cwd(), ".env.local"), override: true });
