import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { Type } from "@sinclair/typebox";

/**
 * Error reports a wallet user chose to send.
 *
 * The report is not stored: it is written as one log line, which a
 * forwarder outside this service reads from the log group and posts to
 * the team's chat. That forwarder depends on the line, so it is pinned
 * by routes/__tests__/errorReports.test.ts:
 *
 *   {"level":30, "time", "pid", "hostname",
 *    "reqId":  the request id, also the `id` in the 202 body and the
 *              response's x-request-id,
 *    "report": the report text exactly as sent,
 *    "msg":    "user.report"}
 *
 * The report is untrusted text. It is safe in the log because it is a
 * JSON string there; whoever displays it has to escape it for where it
 * is shown.
 */

/**
 * Largest report accepted, measured as the UTF-8 bytes of its JSON
 * string encoding, which is what the log line carries. The container
 * runtime splits lines over 16 KiB and a split line is not JSON, so the
 * bound has to hold after escaping, not before.
 */
export const REPORT_MAX_ENCODED_BYTES = 12_000;

/**
 * Requests per window that reach the handler. The app key ships in every
 * install, so the route is open to anyone, and each accepted report
 * becomes a chat message. This cap is the route's own: it holds when
 * RATE_LIMIT_ENABLED is "log" or "false", which production has run in.
 * Counts live in this process, so they reset on restart and each task
 * allows its own `total`.
 */
export const REPORT_HARD_CAP = { perIp: 10, total: 60, windowMs: 60 * 60_000 };
const MAX_TRACKED_IPS = 10_000;

/**
 * Count one request against `key`'s fixed window. Returns 0 when it is
 * within `max`, else the ms until the window ends.
 */
function windowCounter(max: number, windowMs: number) {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return (key: string): number => {
    const now = Date.now();
    let window = windows.get(key);
    if (!window || window.resetAt <= now) {
      windows.delete(key);
      window = { count: 0, resetAt: now + windowMs };
      windows.set(key, window);
      if (windows.size > MAX_TRACKED_IPS) windows.delete(windows.keys().next().value!);
    }
    window.count += 1;
    return window.count <= max ? 0 : window.resetAt - now;
  };
}

export const registerErrorReportRoutes: FastifyPluginAsync = async (server) => {
  const perIp = windowCounter(REPORT_HARD_CAP.perIp, REPORT_HARD_CAP.windowMs);
  const total = windowCounter(REPORT_HARD_CAP.total, REPORT_HARD_CAP.windowMs);

  // An IP over its own cap is turned away before it counts against the
  // shared one, so a single address cannot use up everyone's allowance.
  async function hardCap(request: FastifyRequest, reply: FastifyReply) {
    const waitMs = perIp(request.ip) || total("all");
    if (!waitMs) return;
    const seconds = Math.ceil(waitMs / 1000);
    return reply
      .code(429)
      .header("retry-after", seconds)
      .send({
        statusCode: 429,
        error: "TooManyRequests",
        message: `Error report limit reached, retry in ${Math.ceil(seconds / 60)} minutes`,
      });
  }

  server.post(
    "/error-reports",
    {
      config: { rateLimitGroup: "report" },
      onRequest: hardCap,
      schema: {
        summary: "Send an error report",
        description:
          "Hands a user's error report to the Hub's operators. Send one only when the user asked to. " +
          `Answers 413 when the report's JSON string encoding is over ${REPORT_MAX_ENCODED_BYTES} bytes.`,
        tags: ["system"],
        body: Type.Object({ report: Type.String({ minLength: 1 }) }),
        response: {
          202: Type.Object({ id: Type.String({ description: "The id the report was logged under" }) }),
        },
      },
    },
    async (request, reply) => {
      const { report } = request.body as { report: string };
      if (Buffer.byteLength(JSON.stringify(report), "utf8") > REPORT_MAX_ENCODED_BYTES) {
        return reply.code(413).send({ statusCode: 413, error: "PayloadTooLarge", message: "Report is too large" });
      }
      // `reqId` comes from the request's logger. See the line's shape above.
      request.log.info({ report }, "user.report");
      return reply.code(202).send({ id: request.id });
    },
  );
};
