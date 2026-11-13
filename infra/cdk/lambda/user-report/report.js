"use strict";

// A wallet user's error report, from the Hub's log to Slack.
//
// POST /v1/error-reports on the Hub writes one log line per report:
//   {"level":30, ..., "reqId":"<id>", "report":"<text>", "msg":"user.report"}
// A subscription filter on the API log group hands those lines to this
// function. It posts each one to the reports topic in the only form
// Amazon Q Developer in chat applications (AWS Chatbot) delivers:
// https://docs.aws.amazon.com/chatbot/latest/adminguide/custom-notifs.html
//
// The report and the request id are text a stranger chose: anyone with
// the extension's app key can send one.

const zlib = require("node:zlib");

// The description may be 8,000 characters. The report gets 7,400 of
// them; the request id line, the fences and the note fit in the rest.
const REPORT_MAX = 7400;
const HEAD_MAX = 2000;
const LINE_MAX = 1000;
const REQ_ID_MAX = 100;
const LOG_GROUP_MAX = 300;

// The SDK in the nodejs22.x runtime sets no timeout of its own, so a
// publish that gets no answer would run into the function's 10 seconds.
const PUBLISH_TIMEOUT_MS = 3000;

// Slack reads these three as control characters: <!channel>, <@user>
// and <url|text> all start with one.
const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

// One line of untrusted text, made safe to show in code. The same as
// slackText in ../security-alert/slack.js, which is packaged with the
// alert function only; test/user-report.test.js holds the two together.
// Line breaks and backticks would end the code the text is shown in,
// and a zero-width space follows any @ that could start a mention.
function slackText(value, max) {
  const pieces = Array.from(
    String(value ?? "")
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .trim()
      .replace(/`/g, "'")
      .replace(/(?<![A-Za-z0-9])@/g, "@\u200b"),
    (character) => ENTITIES[character] ?? character
  );
  const text = pieces.join("");
  if (text.length <= max) return text;

  // Cut between pieces so an entity is never split.
  let cut = "";
  for (const piece of pieces) {
    if (cut.length + piece.length > max - 1) break;
    cut += piece;
  }
  return `${cut}…`;
}

// A report starts with its header block and ends with the newest log
// lines, so lines that do not fit are taken from the middle and the cut
// is marked there. `lines` are escaped and at most LINE_MAX long.
function fit(lines) {
  const size = (line) => line.length + 1;
  if (lines.reduce((sum, line) => sum + size(line), 0) <= REPORT_MAX) {
    return lines;
  }
  let head = 0;
  let used = 0;
  while (used + size(lines[head]) <= HEAD_MAX) used += size(lines[head++]);
  // 40 is room for the marker line.
  let room = REPORT_MAX - used - 40;
  let tail = lines.length;
  while (tail > head && size(lines[tail - 1]) <= room) {
    room -= size(lines[--tail]);
  }
  return [
    ...lines.slice(0, head),
    `[… lines cut here: ${tail - head} …]`,
    ...lines.slice(tail),
  ];
}

// `message` is one log line. Throws if it is not the Hub's report line.
function reportNotification(message, logGroup) {
  let line;
  try {
    line = JSON.parse(message);
  } catch {
    line = undefined;
  }
  if (
    line?.msg !== "user.report" ||
    typeof line.report !== "string" ||
    typeof line.reqId !== "string"
  ) {
    throw new Error("not a user.report line");
  }

  let shortened = false;
  const lines = line.report.split("\n").map((raw) => {
    const text = slackText(raw, Infinity);
    if (text.length <= LINE_MAX) return text;
    shortened = true;
    return slackText(raw, LINE_MAX);
  });
  const fitted = fit(lines);
  if (fitted !== lines) shortened = true;
  const report = fitted.join("\n");

  // The fences are the only backticks around the report, so nothing in
  // it can end the block.
  const parts = [
    `*Request ID:* \`${slackText(line.reqId, REQ_ID_MAX)}\``,
    "```",
    report.trim() ? report : "(empty)",
    "```",
  ];
  if (shortened) {
    parts.push(
      `Shortened for Slack. The whole report is the \`user.report\` line with this request ID in log group \`${slackText(logGroup, LOG_GROUP_MAX)}\`.`
    );
  }
  return {
    version: "1.0",
    source: "custom",
    content: {
      textType: "client-markdown",
      title: "Wallet error report",
      description: parts.join("\n"),
    },
  };
}

// CloudWatch Logs sends a subscribed function
// { awslogs: { data: <base64 of gzipped JSON> } }.
function decodeSubscription(event) {
  const data = Buffer.from(event.awslogs.data, "base64");
  return JSON.parse(zlib.gunzipSync(data).toString("utf8"));
}

// Rejects if the publish fails or takes longer than timeoutMs.
// `send(params, { abortSignal })` is the SDK client's send. Aborting
// the signal makes the SDK destroy the request's socket; the race is
// what bounds the wait if the SDK is slow to act on it.
async function publishWithin(send, params, timeoutMs) {
  const controller = new AbortController();
  const timedOut = new Promise((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(new Error(`timed out after ${timeoutMs} ms`)),
      { once: true }
    );
  });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await Promise.race([
      send(params, { abortSignal: controller.signal }),
      timedOut,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Tries every report in the batch once, all at the same time, so the
// batch takes one publish timeout however many it holds. A line that is
// not a report, or a publish that fails, is logged and the rest go on.
//
// Throws at the end if any was not forwarded. That is what the
// function's Errors metric, and the alarm on it, count. The function is
// deployed with no retries: Lambda would run the whole batch again and
// post the reports that did get through a second time.
async function forwardReports(
  send,
  topicArn,
  event,
  timeoutMs = PUBLISH_TIMEOUT_MS
) {
  if (!topicArn) throw new Error("TOPIC_ARN is not set");
  const payload = decodeSubscription(event);
  // CloudWatch Logs also sends control messages to check the function
  // can be reached.
  if (payload.messageType !== "DATA_MESSAGE") {
    return { forwarded: 0, failed: 0 };
  }

  const results = await Promise.all(
    payload.logEvents.map(async (logEvent) => {
      try {
        const notification = reportNotification(
          logEvent?.message,
          payload.logGroup
        );
        await publishWithin(
          send,
          { TopicArn: topicArn, Message: JSON.stringify(notification) },
          timeoutMs
        );
        return true;
      } catch (error) {
        console.error(
          JSON.stringify({
            forwarded: false,
            eventId: logEvent?.id ?? "",
            error: String(error?.message ?? error),
          })
        );
        return false;
      }
    })
  );

  const failed = results.filter((ok) => !ok).length;
  const forwarded = results.length - failed;
  console.log(JSON.stringify({ forwarded, failed }));
  if (failed) {
    throw new Error(
      `${failed} of ${results.length} user reports were not forwarded`
    );
  }
  return { forwarded, failed };
}

module.exports = { decodeSubscription, reportNotification, forwardReports };
