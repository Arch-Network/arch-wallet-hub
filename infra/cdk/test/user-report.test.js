"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const { slackNotification } = require("../lambda/security-alert/slack");
const {
  decodeSubscription,
  reportNotification,
  forwardReports,
} = require("../lambda/user-report/report");

const TOPIC = "arn:aws:sns:us-east-1:590184001652:slack-reports";
const LOG_GROUP = "WalletHubStack-ApiTaskDefapiLogGroup9FDF1262-QSwOGdEbh7LA";
const REQ_ID = "6f1c2a9e-3b7d-4c1e-9a55-0d2e8f4b7c10";
// The Hub refuses a report whose JSON string encoding is larger.
const REPORT_MAX_ENCODED_BYTES = 12_000;

const HEADER = [
  "Arch Wallet error report",
  "Error: Hub request failed (502)",
  `Hub request: ${REQ_ID}`,
  "Version: 0.9.13",
  "Time: 2026-11-13T14:00:00.000Z",
  "Page: popup.html#/send",
  "Wallet: mainnet, Passkey",
  "Browser: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  "",
];

// A report as the wallet's formatErrorDetails writes it.
function report(logLines) {
  return [...HEADER, `Recent log (${logLines.length}):`, ...logLines].join("\n");
}

function logLines(count) {
  return Array.from(
    { length: count },
    (_, i) =>
      `[2026-11-13T13:59:00.000Z] popup INFO request ${i + 1} of ${count} {"status":502,"path":"/v1/indexer/accounts"}`
  );
}

// The line the Hub writes for POST /v1/error-reports.
function hubLine(reportText, reqId = REQ_ID) {
  return JSON.stringify({
    level: 30,
    time: 1794578400000,
    pid: 1,
    hostname: "ip-172-31-20-11.ec2.internal",
    reqId,
    report: reportText,
    msg: "user.report",
  });
}

// What CloudWatch Logs hands a subscribed function.
function subscription(messages, overrides = {}) {
  const payload = {
    messageType: "DATA_MESSAGE",
    owner: "590184001652",
    logGroup: LOG_GROUP,
    logStream: "api/api/0123456789abcdef",
    subscriptionFilters: ["UserReports"],
    logEvents: messages.map((message, i) => ({
      id: `3195310660696698337880902507980421114328961542429822156${i}`,
      timestamp: 1794578400000 + i,
      message,
    })),
    ...overrides,
  };
  return {
    awslogs: {
      data: zlib.gzipSync(JSON.stringify(payload)).toString("base64"),
    },
  };
}

function description(reportText, reqId) {
  return reportNotification(hubLine(reportText, reqId), LOG_GROUP).content
    .description;
}

// The report as shown: what is between the code fences.
function shown(text) {
  const match = /^```\n([\s\S]*)\n```$/m.exec(text);
  assert.ok(match, "the report is in one fenced block");
  return match[1];
}

test("a report becomes a custom notification with its request id", () => {
  const text = report(logLines(3));
  assert.deepEqual(reportNotification(hubLine(text), LOG_GROUP), {
    version: "1.0",
    source: "custom",
    content: {
      textType: "client-markdown",
      title: "Wallet error report",
      description: `*Request ID:* \`${REQ_ID}\`\n\`\`\`\n${text}\n\`\`\``,
    },
  });
});

test("Slack markup and mentions in a report are neutralised", () => {
  const text = report([
    "<!channel> <!here> <@U012AB3CD> <#C012AB3CD> <https://evil.example|click> a&b",
    "@here @channel @everyone",
    "``` *bold* _italic_ ~strike~ `code` ```",
    "tab\there\u0000\u0007and\r",
  ]);
  const result = description(text);
  const block = shown(result);
  assert.doesNotMatch(result, /[<>]/);
  assert.doesNotMatch(result, /&(?!amp;|lt;|gt;)/);
  assert.doesNotMatch(result, /@(here|channel|everyone)/);
  // Only the two fences are backticks, so nothing can end the block.
  assert.equal(block.includes("`"), false);
  assert.equal(result.split("```").length, 3);
  assert.ok(
    block.includes(
      "&lt;!channel&gt; &lt;!here&gt; &lt;@\u200bU012AB3CD&gt; &lt;#C012AB3CD&gt; &lt;https://evil.example|click&gt; a&amp;b"
    )
  );
  assert.ok(block.includes("@\u200bhere @\u200bchannel @\u200beveryone"));
  assert.ok(block.includes("''' *bold* _italic_ ~strike~ 'code' '''"));
  assert.ok(block.endsWith("tab here and"));
  // Line breaks are the report's own: ten header lines and four log lines.
  assert.equal(block.split("\n").length, 14);
});

test("a request id cannot carry markup out of its code span", () => {
  const result = description(report([]), "`<!here>`\n*x* @channel");
  assert.equal(
    result.split("\n")[0],
    "*Request ID:* `'&lt;!here&gt;' *x* @\u200bchannel`"
  );
});

test("a request id is cut to 100 characters", () => {
  const line = description(report([]), "r".repeat(500)).split("\n")[0];
  assert.equal(line, `*Request ID:* \`${"r".repeat(99)}…\``);
});

test("a report of the largest size the Hub accepts keeps its head and its tail", () => {
  let lines = logLines(1);
  while (
    Buffer.byteLength(JSON.stringify(report(logLines(lines.length + 1)))) <=
    REPORT_MAX_ENCODED_BYTES
  ) {
    lines = logLines(lines.length + 1);
  }
  const text = report(lines);
  assert.ok(
    Buffer.byteLength(JSON.stringify(text)) > REPORT_MAX_ENCODED_BYTES - 200
  );

  const result = description(text);
  assert.ok(result.length <= 8000, `description is ${result.length}`);
  const block = shown(result).split("\n");
  // The header block and the oldest lines, then the newest lines.
  assert.deepEqual(block.slice(0, HEADER.length + 2), [
    ...HEADER,
    `Recent log (${lines.length}):`,
    lines[0],
  ]);
  assert.equal(block.at(-1), lines.at(-1));
  const marker = block.findIndex((line) => /^\[… lines cut here: \d+ …\]$/.test(line));
  assert.ok(marker > HEADER.length, "the cut is marked where it was made");
  const cut = Number(/\d+/.exec(block[marker])[0]);
  assert.equal(block.length - 1 + cut, HEADER.length + 1 + lines.length);
  assert.deepEqual(block.slice(marker + 1), lines.slice(-(block.length - marker - 1)));
  // It says so, and where the whole report is.
  assert.equal(
    result.split("\n").at(-1),
    `Shortened for Slack. The whole report is the \`user.report\` line with this request ID in log group \`${LOG_GROUP}\`.`
  );
});

test("a report that fits is not marked as shortened", () => {
  const result = description(report(logLines(20)));
  assert.doesNotMatch(result, /lines cut|Shortened for Slack/);
  assert.ok(result.endsWith("\n```"));
});

test("a long line is cut to 1,000 characters and the report is marked as shortened", () => {
  const result = description(report([`start ${"x".repeat(3000)}`, "last"]));
  const block = shown(result).split("\n");
  assert.equal(block.at(-2), `start ${"x".repeat(993)}…`);
  assert.equal(block.at(-1), "last");
  assert.match(result, /\nShortened for Slack\. /);
  assert.doesNotMatch(result, /lines cut/);
});

test("the description stays inside 8,000 characters whatever the report holds", () => {
  const worst = [
    "&".repeat(REPORT_MAX_ENCODED_BYTES - 2),
    "<\n".repeat((REPORT_MAX_ENCODED_BYTES - 2) / 3),
    `${"a".repeat(1999)}\n${"&".repeat(9000)}`,
    "@".repeat(REPORT_MAX_ENCODED_BYTES - 2),
    "😀".repeat((REPORT_MAX_ENCODED_BYTES - 2) / 4),
  ];
  for (const text of worst) {
    assert.ok(Buffer.byteLength(JSON.stringify(text)) <= REPORT_MAX_ENCODED_BYTES);
    const result = reportNotification(
      hubLine(text, "<".repeat(64)),
      "<".repeat(512)
    ).content.description;
    assert.ok(result.length <= 8000, `description is ${result.length}`);
    // No character was cut in half.
    assert.equal(result.isWellFormed(), true);
    assert.doesNotMatch(result, /[<>]/);
    assert.doesNotMatch(result, /&(?!amp;|lt;|gt;)/);
    assert.equal(result.split("```").length, 3);
    assert.match(result, /\nShortened for Slack\. /);
  }
});

test("a report with nothing in it is still posted", () => {
  assert.equal(shown(description(" \n ")), "(empty)");
});

test("a line that is not a user report is refused", () => {
  const good = JSON.parse(hubLine("r"));
  const bad = [
    "not json",
    "",
    "null",
    '"user.report"',
    "[]",
    JSON.stringify({ ...good, msg: "request.completed" }),
    JSON.stringify({ ...good, report: undefined }),
    JSON.stringify({ ...good, report: { text: "r" } }),
    JSON.stringify({ ...good, reqId: undefined }),
    JSON.stringify({ ...good, reqId: 7 }),
  ];
  for (const message of bad) {
    assert.throws(
      () => reportNotification(message, LOG_GROUP),
      /not a user\.report line/,
      message
    );
  }
});

test("values are escaped exactly as the security alerts escape theirs", () => {
  const samples = [
    "<!channel> <@U012AB3CD> <https://evil.example|x> a&b",
    "a`b\n*bold*\r\n\t_c_",
    "@here x (@everyone) @@here brian@arch.network",
    "  plain text  ",
  ];
  for (const sample of samples) {
    const alert = /^\*User agent:\* `(.*)`$/m.exec(
      slackNotification({ eventName: "x", userAgent: sample }).content.description
    )[1];
    assert.equal(description("r", sample).split("\n")[0], `*Request ID:* \`${alert}\``);
  }
});

test("decodeSubscription reads what CloudWatch Logs sends", () => {
  const payload = decodeSubscription(subscription([hubLine("r")]));
  assert.equal(payload.messageType, "DATA_MESSAGE");
  assert.equal(payload.logGroup, LOG_GROUP);
  assert.equal(payload.logEvents.length, 1);
  assert.equal(JSON.parse(payload.logEvents[0].message).report, "r");
});

test("a payload that is not gzipped JSON is an error", () => {
  for (const event of [
    undefined,
    {},
    { awslogs: {} },
    { awslogs: { data: "not gzip" } },
    { awslogs: { data: zlib.gzipSync("not json").toString("base64") } },
  ]) {
    assert.throws(() => decodeSubscription(event));
  }
});

function recorder() {
  const sent = [];
  const send = async (params, options) => {
    sent.push({ params, options });
  };
  return { sent, send };
}

test("each report in a batch is published to the reports topic", async (t) => {
  const logged = t.mock.method(console, "log", () => {});
  const { sent, send } = recorder();
  const reports = [report(logLines(1)), report(logLines(2))];
  const result = await forwardReports(send, TOPIC, subscription(reports.map((r) => hubLine(r))));
  assert.deepEqual(result, { forwarded: 2, failed: 0 });
  assert.equal(sent.length, 2);
  for (const [i, { params }] of sent.entries()) {
    assert.deepEqual(Object.keys(params).sort(), ["Message", "TopicArn"]);
    assert.equal(params.TopicArn, TOPIC);
    assert.deepEqual(
      JSON.parse(params.Message),
      reportNotification(hubLine(reports[i]), LOG_GROUP)
    );
  }
  assert.deepEqual(JSON.parse(logged.mock.calls.at(-1).arguments[0]), {
    forwarded: 2,
    failed: 0,
  });
});

test("a malformed event is logged and does not stop the others", async (t) => {
  t.mock.method(console, "log", () => {});
  const errors = t.mock.method(console, "error", () => {});
  const { sent, send } = recorder();
  await assert.rejects(
    forwardReports(
      send,
      TOPIC,
      subscription([hubLine("first"), '{"msg":"user.report","report":7}', hubLine("third")])
    ),
    /1 of 3 user reports were not forwarded/
  );
  assert.deepEqual(
    sent.map(({ params }) => shown(JSON.parse(params.Message).content.description)),
    ["first", "third"]
  );
  assert.equal(errors.mock.callCount(), 1);
  assert.deepEqual(JSON.parse(errors.mock.calls[0].arguments[0]), {
    forwarded: false,
    eventId: "31953106606966983378809025079804211143289615424298221561",
    error: "not a user.report line",
  });
});

test("a failed publish is logged and does not stop the others", async (t) => {
  t.mock.method(console, "log", () => {});
  const errors = t.mock.method(console, "error", () => {});
  const sent = [];
  const send = async (params) => {
    if (params.Message.includes("second")) throw new Error("AuthorizationError: not allowed");
    sent.push(params);
  };
  await assert.rejects(
    forwardReports(send, TOPIC, subscription(["first", "second", "third"].map((r) => hubLine(r)))),
    /1 of 3 user reports were not forwarded/
  );
  assert.equal(sent.length, 2);
  assert.deepEqual(JSON.parse(errors.mock.calls[0].arguments[0]), {
    forwarded: false,
    eventId: "31953106606966983378809025079804211143289615424298221561",
    error: "AuthorizationError: not allowed",
  });
});

test("a publish that never settles is given up at the bound and aborted", async (t) => {
  t.mock.method(console, "log", () => {});
  const errors = t.mock.method(console, "error", () => {});
  const signals = [];
  const started = Date.now();
  await assert.rejects(
    forwardReports(
      (params, options) => {
        signals.push(options.abortSignal);
        return new Promise(() => {});
      },
      TOPIC,
      subscription([hubLine("first"), hubLine("second")]),
      20
    ),
    /2 of 2 user reports were not forwarded/
  );
  // Both waited at once: the batch takes one bound, not one each.
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
  assert.deepEqual(signals.map((signal) => signal.aborted), [true, true]);
  assert.equal(errors.mock.callCount(), 2);
  assert.equal(JSON.parse(errors.mock.calls[0].arguments[0]).error, "timed out after 20 ms");
});

test("a publish inside the bound is not aborted and leaves no timer", async (t) => {
  t.mock.method(console, "log", () => {});
  const cleared = t.mock.method(globalThis, "clearTimeout");
  const { sent, send } = recorder();
  await forwardReports(send, TOPIC, subscription([hubLine("r")]), 60_000);
  assert.equal(sent[0].options.abortSignal.aborted, false);
  assert.equal(cleared.mock.callCount(), 1);
});

test("a control message publishes nothing", async () => {
  const { sent, send } = recorder();
  const result = await forwardReports(
    send,
    TOPIC,
    subscription(["CWL CONTROL MESSAGE: Checking health of destination Lambda"], {
      messageType: "CONTROL_MESSAGE",
    })
  );
  assert.deepEqual(result, { forwarded: 0, failed: 0 });
  assert.equal(sent.length, 0);
});

test("without a topic nothing is published and the invocation fails", async () => {
  const { sent, send } = recorder();
  await assert.rejects(
    forwardReports(send, "", subscription([hubLine("r")])),
    /TOPIC_ARN is not set/
  );
  assert.equal(sent.length, 0);
});
