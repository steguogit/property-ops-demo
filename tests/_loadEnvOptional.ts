// Loads .env if present (for integration tests against a live cluster) but
// never fails if it is missing — unit tests run without any DB.
import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(process.cwd(), ".env") });
