import { fileURLToPath } from "node:url";

/** The folder OmniPilot may read and (with approval) change: server/workspace, or OMNIPILOT_WORKSPACE. */
export const WORKSPACE_ROOT = process.env.OMNIPILOT_WORKSPACE ?? fileURLToPath(new URL("../../workspace", import.meta.url));
