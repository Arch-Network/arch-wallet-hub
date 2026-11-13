"use strict";

// The Slack copy of a page. Amazon Q Developer in chat applications
// (AWS Chatbot) drops an SNS message that is neither an AWS service
// event nor its custom-notification schema, so the JSON the email
// recipients get would never reach the channel. Schema and limits:
// https://docs.aws.amazon.com/chatbot/latest/adminguide/custom-notifs.html

// Documented maximums. The description holds at most seven values and
// the note, each cut to VALUE_MAX, so it cannot come near its 8,000.
const TITLE_MAX = 250;
const VALUE_MAX = 300;

const FIELDS = [
  ["Target", "target"],
  ["Actor", "actor"],
  ["Source IP", "sourceIPAddress"],
  ["Invoked by", "invokedBy"],
  ["User agent", "userAgent"],
  ["Error", "errorCode"],
  ["Time", "eventTime"],
];

// Slack reads these three as control characters: <!channel>, <@user>
// and <url|text> all start with one.
const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

// Every field of a page can carry text the caller chose (userAgent, a
// role session name, a task family), so each goes through here.
// Line breaks and backticks would end the code span a value is shown
// in. The custom-notification docs only describe <@id> mentions, but
// their own sample writes a bare @name, so a zero-width space follows
// any @ that could start one; an address such as a@b.c is untouched.
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

// `message` is the object decide() pages with.
function slackNotification(message) {
  const lines = [];
  for (const [label, key] of FIELDS) {
    const value = slackText(message[key], VALUE_MAX);
    if (value) lines.push(`*${label}:* \`${value}\``);
  }
  const note = slackText(message.note, VALUE_MAX);
  if (note) lines.push(note);

  return {
    version: "1.0",
    source: "custom",
    content: {
      textType: "client-markdown",
      title: slackText(`Security alert: ${message.eventName}`, TITLE_MAX),
      description: lines.join("\n"),
    },
  };
}

// Never throws. By the time this runs the page has been published; a
// failure here would make EventBridge retry the event and send that
// page again.
async function publishToSlack(send, topicArn, message) {
  if (!topicArn) return false;
  try {
    await send({
      TopicArn: topicArn,
      Message: JSON.stringify(slackNotification(message)),
    });
    return true;
  } catch (error) {
    console.error(
      JSON.stringify({
        slackPublished: false,
        eventName: message?.eventName ?? "",
        error: String(error?.message ?? error),
      })
    );
    return false;
  }
}

module.exports = { slackNotification, publishToSlack };
