// @vitest-environment happy-dom
/**
 * A token row is reused while its metadata resolves, so one failed
 * image must not stop a later, working URL from showing.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { TokenIcon } from "../TokenIcon";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;

let root: Root | null = null;

function mount() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  const show = (image: string | null, wrapperClassName?: string) =>
    flushSync(() =>
      root!.render(createElement(TokenIcon, { image, symbol: "aUSD", wrapperClassName })),
    );
  const failImage = () =>
    flushSync(() => {
      el.querySelector("img")!.dispatchEvent(new Event("error"));
    });
  return { el, show, failImage };
}

afterEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = "";
});

describe("TokenIcon", () => {
  for (const wrapperClassName of [undefined, "asset-icon apl"]) {
    const mode = wrapperClassName ? "wrapped" : "standalone";

    it(`${mode}: shows a working image after an earlier URL failed`, () => {
      const { el, show, failImage } = mount();

      show("https://tokens.example/broken.png", wrapperClassName);
      failImage();
      expect(el.querySelector("img")).toBeNull();
      expect(el.querySelector("svg")).not.toBeNull();

      show("https://tokens.example/usdc.png", wrapperClassName);
      expect(el.querySelector("img")?.getAttribute("src")).toBe("https://tokens.example/usdc.png");
    });

    it(`${mode}: keeps the fallback for the URL that failed`, () => {
      const { el, show, failImage } = mount();

      show("https://tokens.example/broken.png", wrapperClassName);
      failImage();
      show("https://tokens.example/broken.png", wrapperClassName);
      expect(el.querySelector("img")).toBeNull();
    });
  }

  it("shows the fallback when there is no image", () => {
    const { el, show } = mount();
    show(null);
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("svg")).not.toBeNull();
  });
});
