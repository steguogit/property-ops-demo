// Loads .env for standalone tsx scripts before any lib imports run.
import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(process.cwd(), ".env") });
