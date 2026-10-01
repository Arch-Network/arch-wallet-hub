import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { registerObservability } from "../observability.js";

/**
 * Regression guard for the globally-missing `request.completed` log event.
 *
 * `registerObservability` adds an `onResponse` hook. If it is registered as a
 * bare (non-fastify-plugin) async plugin, the hook is confined to the plugin's
 * encapsulated child scope and never fires for routes registered in sibling
 * scopes — so `request.completed` was emitted for ZERO requests in production
 * (same class of bug as the pre-fix registerDb encapsulation).
 *
 * Wrapping it in `fastify-plugin` hoists the hook to the root instance so it
 * fires for ALL routes. We assert that here by registering the plugin and a
 * sibling route, then confirming the structured event is logged at `info`.
 */
describe("observability request.completed hook", () => {
  it("fires for routes registered in sibling scopes", async () => {
    const logged: Array<{ obj: unknown; msg?: string }> = [];

    const app = Fastify({
      logger: {
        level: "info",
        // Capture structured log records so we can assert on the event.
        stream: {
          write(line: string) {
            const rec = JSON.parse(line);
            logged.push({ obj: rec, msg: rec.msg });
          },
        },
      },
    });

    await app.register(registerObservability);

    // Route registered as a SIBLING of the observability plugin — exactly the
    // shape that previously failed to trigger the encapsulated hook.
    await app.register(async (sibling) => {
      sibling.get("/ping", async () => ({ ok: true }));
    });

    await app.ready();

    const res = await app.inject({ method: "GET", url: "/ping" });
    expect(res.statusCode).toBe(200);

    const completed = logged.find((l) => l.msg === "request.completed");
    expect(completed).toBeDefined();

    const rec = completed!.obj as Record<string, unknown>;
    expect(rec.method).toBe("GET");
    expect(rec.url).toBe("/ping");
    expect(rec.statusCode).toBe(200);
    expect(typeof rec.responseTimeMs).toBe("number");

    await app.close();
  });
});
