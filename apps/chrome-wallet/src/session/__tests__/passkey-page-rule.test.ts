import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const rulePath = fileURLToPath(new URL("../../../public/rules/passkey-page.json", import.meta.url));
const rules = JSON.parse(readFileSync(rulePath, "utf8")) as Array<{
  id: number;
  action: {
    type: string;
    responseHeaders: Array<{ header: string; operation: string; value: string }>;
  };
  condition: { requestDomains: string[]; urlFilter: string; resourceTypes: string[] };
}>;

describe("passkey page response rule", () => {
  it("forces wallet.arch.network/passkey.html to HTML so 1Password can inject", () => {
    expect(rules).toHaveLength(1);
    expect(rules[0]?.id).toBe(1);
    expect(rules[0]?.action).toEqual({
      type: "modifyHeaders",
      responseHeaders: [
        {
          header: "content-type",
          operation: "set",
          value: "text/html; charset=utf-8",
        },
      ],
    });
    expect(rules[0]?.condition.requestDomains).toEqual(["wallet.arch.network"]);
    expect(rules[0]?.condition.urlFilter).toBe("passkey.html");
    expect(rules[0]?.condition.resourceTypes).toEqual(["main_frame"]);
  });
});
