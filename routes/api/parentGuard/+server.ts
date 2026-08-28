// Dev-only. The handler lives in lib so the parent that serves its own routes
// can mount the same one — see lib/dev/parentGuard.server.ts.
export { GET } from "../../../lib/dev/parentGuard.server";
