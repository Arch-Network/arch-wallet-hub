import { describe, expect, it } from "vitest";
import {
  DEFAULT_POPUP_BOUNDS,
  isWalletPopupDocumentUrl,
  listResizableWalletWindowIds,
  sanitizePopupBounds,
  selectResizableWalletWindow,
} from "../popup-bounds";

describe("sanitizePopupBounds", () => {
  it("keeps a size the user could actually drag a window to", () => {
    expect(sanitizePopupBounds({ width: 720.4, height: 900.2 })).toEqual({
      width: 720,
      height: 900,
    });
  });

  it("rejects missing, tiny, and oversized values", () => {
    expect(sanitizePopupBounds(null)).toBeNull();
    expect(sanitizePopupBounds({ width: 200, height: 640 })).toBeNull();
    expect(sanitizePopupBounds({ width: 400, height: 100 })).toBeNull();
    expect(sanitizePopupBounds({ width: 4000, height: 800 })).toBeNull();
    expect(sanitizePopupBounds({ width: "400", height: 640 })).toBeNull();
  });

  it("exposes the first-open size", () => {
    expect(DEFAULT_POPUP_BOUNDS).toEqual({ width: 400, height: 640 });
  });
});

describe("isWalletPopupDocumentUrl", () => {
  it("matches HashRouter wallet routes and rejects approve prompts", () => {
    expect(isWalletPopupDocumentUrl("chrome-extension://id/popup.html")).toBe(true);
    expect(isWalletPopupDocumentUrl("chrome-extension://id/popup.html#/dashboard")).toBe(true);
    expect(isWalletPopupDocumentUrl("chrome-extension://id/popup.html#/send")).toBe(true);
    expect(isWalletPopupDocumentUrl("chrome-extension://id/popup.html#/approve/abc")).toBe(false);
    expect(isWalletPopupDocumentUrl("chrome-extension://id/sidepanel.html")).toBe(false);
    // The old getContexts glob is not a real document URL.
    expect(isWalletPopupDocumentUrl("chrome-extension://id/popup.html*")).toBe(false);
  });
});

describe("selectResizableWalletWindow", () => {
  it("focuses the wallet window and leaves an approve prompt alone", () => {
    expect(selectResizableWalletWindow([
      { documentUrl: "chrome-extension://id/popup.html#/approve/abc", windowId: 2 },
      { documentUrl: "chrome-extension://id/popup.html#/send", windowId: 9 },
    ])).toBe(9);
  });

  it("returns undefined when the only popup is an approve prompt", () => {
    expect(selectResizableWalletWindow([
      { documentUrl: "chrome-extension://id/popup.html#/approve/abc", windowId: 2 },
    ])).toBeUndefined();
  });

  it("dedupes stacked copies of the same wallet window", () => {
    expect(listResizableWalletWindowIds([
      { documentUrl: "chrome-extension://id/popup.html#/dashboard", windowId: 4 },
      { documentUrl: "chrome-extension://id/popup.html#/dashboard", windowId: 4 },
      { documentUrl: "chrome-extension://id/popup.html#/tokens", windowId: 8 },
    ])).toEqual([4, 8]);
  });
});
