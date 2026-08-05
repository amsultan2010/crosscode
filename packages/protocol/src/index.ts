import { z } from "zod";

// The sync wire contract lives in ./sync.ts and is re-exported below. What remains here is
// the local daemon's own on-disk shapes, which are not part of the wire protocol: where the
// daemon advertises its loopback port, and the account-side config `crosscode start` writes
// before a daemon exists.

export const daemonConnectionSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65_535),
  secret: z.string().min(1),
  startedAt: z.string().datetime()
}).strict();
export type DaemonConnection = z.infer<typeof daemonConnectionSchema>;

export const daemonServiceConfigSchema = z.object({
  url: z.string().url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" || (
      url.protocol === "http:"
      && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    );
  }, "Service URL must use HTTPS or loopback HTTP"),
  session: z.object({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
    expiresAt: z.string().datetime()
  }).strict().optional()
}).strict();
export type DaemonServiceConfig = z.infer<typeof daemonServiceConfigSchema>;

export const daemonConfigSchema = z.object({
  workspaceId: z.string().min(1),
  replicaId: z.string().min(1).optional(),
  actorId: z.string().min(1),
  service: daemonServiceConfigSchema.optional()
}).strict();
export type DaemonConfig = z.infer<typeof daemonConfigSchema>;

export * from "./sync.js";
