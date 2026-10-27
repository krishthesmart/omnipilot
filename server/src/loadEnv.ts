import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// Settings and keys: server/.env first, then .env in the project folder for anything not set there.
// The shell's own environment always wins (dotenv never overrides a variable that's already set).
const here = path.dirname(fileURLToPath(import.meta.url));
for (const file of [path.join(here, "..", ".env"), path.join(here, "..", "..", ".env")]) dotenv.config({ path: file, quiet: true });

// Accept the Browser Use key under either spelling.
if (!process.env.BROWSER_USE_API_KEY && process.env.BROWSERUSE_API_KEY) process.env.BROWSER_USE_API_KEY = process.env.BROWSERUSE_API_KEY;
