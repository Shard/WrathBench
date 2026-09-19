/**
 * One-off: PUT the data hostname's robots.txt now, with the publisher's own
 * credentials, instead of waiting for the next release to carry the publisher
 * that writes it at start-up (`infra/publish-dashboard.ts`).
 *
 *   bun infra/publish-robots.ts
 */
import { S3Client } from "bun";
import { ROBOTS_KEY, ROBOTS_TXT } from "./robots";

const s3 = new S3Client();
await s3.write(ROBOTS_KEY, ROBOTS_TXT, { type: "text/plain; charset=utf-8" });
console.log(`wrote ${ROBOTS_KEY} (${ROBOTS_TXT.length} bytes)`);
