/**
 * Shared Turnkey activity settlement.
 *
 * `@turnkey/http`'s raw client does not poll. Their `createActivityPoller`
 * returns immediately when the *submit* response is already terminal.
 * Our previous poller always issued a follow-up `getActivity`, which added
 * a full extra RTT to every mutation — including INIT_OTP_AUTH, whose
 * submit response is often already COMPLETED with an otpId.
 */

export const TERMINAL_ACTIVITY_STATUSES = [
  "ACTIVITY_STATUS_COMPLETED",
  "ACTIVITY_STATUS_FAILED",
  "ACTIVITY_STATUS_REJECTED",
  "ACTIVITY_STATUS_CONSENSUS_NEEDED"
] as const;

export type TurnkeyActivityLike = {
  id?: string;
  status?: string;
  organizationId?: string;
  result?: unknown;
};

export function isTerminalActivityStatus(
  status: string | undefined
): boolean {
  return (
    !!status &&
    (TERMINAL_ACTIVITY_STATUSES as readonly string[]).includes(status)
  );
}

/**
 * INIT_OTP_AUTH v1 returns `initOtpAuthResult`; v2/v3 return
 * `initOtpAuthResultV2`. Accept both so a silent SDK/activity bump
 * does not look like a missing otpId after a successful send.
 */
export function extractOtpId(
  activity: TurnkeyActivityLike | null | undefined
): string | undefined {
  const result = activity?.result;
  if (!result || typeof result !== "object") return undefined;
  const record = result as Record<string, { otpId?: unknown } | undefined>;
  const otpId =
    record.initOtpAuthResult?.otpId ?? record.initOtpAuthResultV2?.otpId;
  return typeof otpId === "string" && otpId.length > 0 ? otpId : undefined;
}

export async function waitForActivity(params: {
  activityId: string;
  organizationId: string;
  initial?: TurnkeyActivityLike;
  getActivity: (input: {
    activityId: string;
    organizationId: string;
  }) => Promise<TurnkeyActivityLike>;
  maxAttempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ activity: TurnkeyActivityLike; pollAttempts: number }> {
  const maxAttempts = params.maxAttempts ?? 60;
  const delayMs = params.delayMs ?? 500;
  const sleep =
    params.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  if (params.initial && isTerminalActivityStatus(params.initial.status)) {
    return { activity: params.initial, pollAttempts: 0 };
  }

  let orgId = params.initial?.organizationId ?? params.organizationId;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const activity = await params.getActivity({
      activityId: params.activityId,
      organizationId: orgId
    });
    if (activity.organizationId) orgId = activity.organizationId;
    if (isTerminalActivityStatus(activity.status)) {
      return { activity, pollAttempts: attempt };
    }
    if (attempt < maxAttempts) await sleep(delayMs);
  }

  throw new Error(`Turnkey activity polling timed out: ${params.activityId}`);
}
