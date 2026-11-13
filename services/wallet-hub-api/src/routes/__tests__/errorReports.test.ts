import sensible from "@fastify/sensible";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOG_REDACT, TRUST_PROXY_HOPS } from "../../server.js";
import { genRequestId, registerObservability } from "../../plugins/observability.js";
import { RATE_LIMITS, registerRateLimit } from "../../plugins/rateLimit.js";
import {
  REPORT_HARD_CAP,
  REPORT_MAX_ENCODED_BYTES,
  registerErrorReportRoutes,
} from "../errorReports.js";

/**
 * POST /v1/error-reports turns a wallet user's report into one
 * `user.report` log line. A forwarder outside this service reads that
 * line, so its shape and size are pinned here. The server is built with
 * the logger, request-id and proxy options `createServer` uses.
 */
const ALB = "172.31.40.10";
const CLIENT = "203.0.113.7";
// The container runtime splits log lines above this, and a split line is not JSON.
const LOG_LINE_SPLIT_BYTES = 16 * 1024;

async function buildServer(mode: "enforce" | "log" | "off" = "log") {
  const lines: string[] = [];
  const app = Fastify({
    trustProxy: TRUST_PROXY_HOPS,
    requestIdHeader: false,
    genReqId: genRequestId,
    logger: { level: "info", redact: LOG_REDACT, stream: { write: (line: string) => lines.push(line) } },
  });
  app.decorate("config", { RATE_LIMIT_ENABLED: mode } as never);
  // Stand-in for appAuth: every install shares one app key.
  app.addHook("onRequest", async (request) => {
    (request as any).app = { appId: "chrome-wallet", apiKeyId: "chrome-wallet-key", apiKeyPrefix: "p" };
  });
  await app.register(sensible);
  await app.register(registerObservability);
  await app.register(registerRateLimit);
  await app.register(registerErrorReportRoutes, { prefix: "/v1" });
  await app.ready();
  const reportLines = () => lines.filter((line) => JSON.parse(line).msg === "user.report");
  return { app, reportLines };
}

type Server = Awaited<ReturnType<typeof buildServer>>["app"];

function send(app: Server, body: unknown, ip = CLIENT) {
  return app.inject({
    method: "POST",
    url: "/v1/error-reports",
    remoteAddress: ALB,
    headers: { "x-forwarded-for": ip, "content-type": "application/json" },
    payload: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** A report whose JSON string encoding is exactly `bytes` long: every `"` encodes to two bytes. */
function reportEncodingTo(bytes: number): string {
  return '"'.repeat((bytes - 2) / 2);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /v1/error-reports", () => {
  it("answers 202 with the id the report is logged under", async () => {
    const { app, reportLines } = await buildServer();
    const report = "Arch Wallet error report\nError: boom\nVersion: 0.9.13";
    const res = await send(app, { report });

    expect(res.statusCode).toBe(202);
    const id = res.headers["x-request-id"];
    expect(res.json()).toEqual({ id });
    expect(reportLines().map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ level: 30, msg: "user.report", reqId: id, report }),
    ]);
    await app.close();
  });

  it("writes exactly the fields the forwarder reads, once each", async () => {
    const { app, reportLines } = await buildServer();
    await send(app, { report: "boom" });
    const line = reportLines()[0];
    // Read as text: a key written twice would parse to an object that hides it.
    const keys = [...line.matchAll(/"([A-Za-z]+)":/g)].map((m) => m[1]).sort();
    expect(keys).toEqual(["hostname", "level", "msg", "pid", "report", "reqId", "time"]);
    await app.close();
  });

  it("logs untrusted text as one JSON string on one line", async () => {
    const { app, reportLines } = await buildServer();
    const report = 'line one\nline two\r\n<!channel> "quoted" \\ \u0000\u001b[31m {"msg":"request.completed"} authorization: Bearer x';
    const res = await send(app, { report });

    expect(res.statusCode).toBe(202);
    expect(reportLines()).toHaveLength(1);
    const line = reportLines()[0];
    expect(line.endsWith("\n")).toBe(true);
    expect(line.trimEnd()).not.toMatch(/[\n\r\u0000-\u001f]/);
    expect(JSON.parse(line).report).toBe(report);
    expect(JSON.parse(line).msg).toBe("user.report");
    await app.close();
  });

  it("keeps the largest report it accepts on a log line the runtime will not split", async () => {
    const { app, reportLines } = await buildServer();
    const report = reportEncodingTo(REPORT_MAX_ENCODED_BYTES);
    expect(Buffer.byteLength(JSON.stringify(report))).toBe(REPORT_MAX_ENCODED_BYTES);
    const res = await send(app, { report });

    expect(res.statusCode).toBe(202);
    const line = reportLines()[0];
    expect(JSON.parse(line).report).toBe(report);
    // Everything but the report is a few hundred bytes: ids, time, host name.
    expect(Buffer.byteLength(line)).toBeLessThan(REPORT_MAX_ENCODED_BYTES + 1024);
    expect(Buffer.byteLength(line)).toBeLessThan(LOG_LINE_SPLIT_BYTES);
    await app.close();
  });

  it("refuses a report over the size bound without logging it", async () => {
    const { app, reportLines } = await buildServer();
    // Under the bound as characters, over it once encoded for the log.
    const escaped = await send(app, { report: reportEncodingTo(REPORT_MAX_ENCODED_BYTES + 2) });
    const multibyte = await send(app, { report: "é".repeat(REPORT_MAX_ENCODED_BYTES / 2) });
    const huge = await send(app, { report: "a".repeat(64 * 1024) });

    expect([escaped.statusCode, multibyte.statusCode, huge.statusCode]).toEqual([413, 413, 413]);
    expect(reportLines()).toEqual([]);
    await app.close();
  });

  it("refuses a body that is not a report without logging it", async () => {
    const { app, reportLines } = await buildServer();
    const statuses = [];
    for (const body of [{}, { report: "" }, { text: "boom" }, "not json", "null"]) {
      statuses.push((await send(app, body)).statusCode);
    }
    expect(statuses).toEqual([400, 400, 400, 400, 400]);
    expect(reportLines()).toEqual([]);
    await app.close();
  });
});

describe("error report limits", () => {
  it("counts against the report group, per IP, when the limiter enforces", async () => {
    const { app } = await buildServer("enforce");
    const max = RATE_LIMITS.report.max;
    const statuses = [];
    for (let i = 0; i < max + 1; i++) statuses.push((await send(app, { report: "boom" })).statusCode);

    expect(statuses).toEqual([...Array(max).fill(202), 429]);
    expect((await send(app, { report: "boom" }, "198.51.100.1")).statusCode).toBe(202);
    await app.close();
  });

  it.each(["log", "off"] as const)("caps reports per IP when the limiter is in %s mode", async (mode) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { app, reportLines } = await buildServer(mode);
    const statuses = [];
    // A refused body counts too: the cap is on requests, not on accepted reports.
    statuses.push((await send(app, {})).statusCode);
    for (let i = 0; i < REPORT_HARD_CAP.perIp; i++) statuses.push((await send(app, { report: "boom" })).statusCode);

    expect(statuses).toEqual([400, ...Array(REPORT_HARD_CAP.perIp - 1).fill(202), 429]);
    expect(reportLines()).toHaveLength(REPORT_HARD_CAP.perIp - 1);

    const over = await send(app, { report: "boom" });
    expect(over.statusCode).toBe(429);
    expect(over.json()).toMatchObject({ statusCode: 429, error: "TooManyRequests" });
    expect(Number(over.headers["retry-after"])).toBeGreaterThan(0);
    expect((await send(app, { report: "boom" }, "198.51.100.1")).statusCode).toBe(202);

    vi.setSystemTime(Date.now() + REPORT_HARD_CAP.windowMs);
    expect((await send(app, { report: "boom" })).statusCode).toBe(202);
    await app.close();
  });

  it("caps reports from all IPs together, so many addresses cannot flood the log", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { app, reportLines } = await buildServer("log");
    const statuses = [];
    for (let i = 0; i < REPORT_HARD_CAP.total + 1; i++) {
      statuses.push((await send(app, { report: "boom" }, `198.51.100.${i}`)).statusCode);
    }

    expect(statuses).toEqual([...Array(REPORT_HARD_CAP.total).fill(202), 429]);
    expect(reportLines()).toHaveLength(REPORT_HARD_CAP.total);

    vi.setSystemTime(Date.now() + REPORT_HARD_CAP.windowMs);
    expect((await send(app, { report: "boom" }, "198.51.100.200")).statusCode).toBe(202);
    await app.close();
  });

  it("does not let one IP use up the shared allowance", async () => {
    const { app } = await buildServer("log");
    for (let i = 0; i < REPORT_HARD_CAP.total * 2; i++) await send(app, { report: "boom" });
    expect((await send(app, { report: "boom" }, "198.51.100.1")).statusCode).toBe(202);
    await app.close();
  });
});
