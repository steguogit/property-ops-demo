import "./_loadEnv";
import { getCollection } from "../src/lib/mongo";
import { env } from "../src/lib/env";

async function main() {
  const col = await getCollection();
  const res = await col.deleteMany({});
  console.log(
    `Cleared ${res.deletedCount} chunks from ${env.dbName}.${env.collectionName}. Run 'npm run seed' to reload.`
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
