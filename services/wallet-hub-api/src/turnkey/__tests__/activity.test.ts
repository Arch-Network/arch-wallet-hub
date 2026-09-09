import { describe, expect, it, vi } from "vitest";
import {
  extractOtpId,
  isTerminalActivityStatus,
  waitForActivity,
  type TurnkeyActivityLike
} from "../activity.js";

function activity(
  overrides: Partial<TurnkeyActivityLike> = {}
): TurnkeyActivityLike {
  return {
    id: "act-1",
    status: "ACTIVITY_STATUS_PENDING",
    organizationId: "org-1",
    ...overrides
  };
}

describe("Turnkey activity settlement", () => {
  it("treats completed/failed/rejected/consensus as terminal", () => {
    expect(isTerminalActivityStatus("ACTIVITY_STATUS_COMPLETED")).toBe(true);
    expect(isTerminalActivityStatus("ACTIVITY_STATUS_FAILED")).toBe(true);
    expect(isTerminalActivityStatus("ACTIVITY_STATUS_REJECTED")).toBe(true);
    expect(isTerminalActivityStatus("ACTIVITY_STATUS_CONSENSUS_NEEDED")).toBe(
      true
    );
    expect(isTerminalActivityStatus("ACTIVITY_STATUS_PENDING")).toBe(false);
    expect(isTerminalActivityStatus("ACTIVITY_STATUS_CREATED")).toBe(false);
    expect(isTerminalActivityStatus(undefined)).toBe(false);
  });

  it("reads otpId from v1 and v2/v3 result shapes", () => {
    expect(
      extractOtpId(activity({ result: { initOtpAuthResult: { otpId: "otp-v1" } } }))
    ).toBe("otp-v1");
    expect(
      extractOtpId(
        activity({ result: { initOtpAuthResultV2: { otpId: "otp-v2" } } })
      )
    ).toBe("otp-v2");
    expect(extractOtpId(activity({ result: {} }))).toBeUndefined();
  });

  it("returns the submit activity without getActivity when already terminal", async () => {
    const getActivity = vi.fn();
    const initial = activity({
      status: "ACTIVITY_STATUS_COMPLETED",
      result: { initOtpAuthResult: { otpId: "otp-1" } }
    });

    const settled = await waitForActivity({
      activityId: "act-1",
      organizationId: "org-1",
      initial,
      getActivity
    });

    expect(settled.pollAttempts).toBe(0);
    expect(settled.activity).toBe(initial);
    expect(getActivity).not.toHaveBeenCalled();
  });

  it("polls until the activity becomes terminal", async () => {
    const getActivity = vi
      .fn()
      .mockResolvedValueOnce(activity({ status: "ACTIVITY_STATUS_PENDING" }))
      .mockResolvedValueOnce(
        activity({
          status: "ACTIVITY_STATUS_COMPLETED",
          result: { initOtpAuthResult: { otpId: "otp-2" } }
        })
      );
    const sleep = vi.fn(async () => {});

    const settled = await waitForActivity({
      activityId: "act-1",
      organizationId: "org-1",
      initial: activity({ status: "ACTIVITY_STATUS_PENDING" }),
      getActivity,
      sleep,
      delayMs: 25
    });

    expect(settled.pollAttempts).toBe(2);
    expect(extractOtpId(settled.activity)).toBe("otp-2");
    expect(getActivity).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(25);
  });

  it("follows organizationId from the activity when polling", async () => {
    const getActivity = vi.fn().mockResolvedValue(
      activity({
        status: "ACTIVITY_STATUS_COMPLETED",
        organizationId: "sub-org"
      })
    );

    await waitForActivity({
      activityId: "act-1",
      organizationId: "parent-org",
      initial: activity({
        status: "ACTIVITY_STATUS_PENDING",
        organizationId: "sub-org"
      }),
      getActivity
    });

    expect(getActivity).toHaveBeenCalledWith({
      activityId: "act-1",
      organizationId: "sub-org"
    });
  });

  it("times out after maxAttempts", async () => {
    const getActivity = vi
      .fn()
      .mockResolvedValue(activity({ status: "ACTIVITY_STATUS_PENDING" }));

    await expect(
      waitForActivity({
        activityId: "act-1",
        organizationId: "org-1",
        getActivity,
        maxAttempts: 2,
        sleep: async () => {}
      })
    ).rejects.toThrow("Turnkey activity polling timed out: act-1");
    expect(getActivity).toHaveBeenCalledTimes(2);
  });
});
