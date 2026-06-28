import type { DigestData, DigestItem, WorkItemType } from "./work-items";

// ============================================================================
// Morning digest message: "Here's what was added yesterday, what got done,
// and the most important thing to focus on today." Reads from the board
// (work_items). v1 is grounded entirely in board data; as the post-meeting
// hook and other signals land they enrich the same DigestData shape.
// ============================================================================

const TYPE_EMOJI: Record<WorkItemType, string> = {
  followup: ":email:",
  crm_update: ":card_index_dividers:",
  prep: ":clipboard:",
  task: ":white_square_button:",
};

function line(it: DigestItem): string {
  const who = it.ownerEmail ? ` — ${it.ownerEmail.split("@")[0]}` : "";
  const acct = it.customerSlug ? ` _(${it.customerSlug})_` : "";
  return `${TYPE_EMOJI[it.type]} ${it.title}${acct}${who}`;
}

function bulletList(items: DigestItem[], max = 5): string {
  if (items.length === 0) return "_nothing_";
  const shown = items.slice(0, max).map((it) => `• ${line(it)}`);
  if (items.length > max) shown.push(`• …and ${items.length - max} more`);
  return shown.join("\n");
}

/** Plain-text fallback (notifications, screen readers, no-blocks clients). */
export function buildDigestText(d: DigestData): string {
  return [
    `GTM Morning Digest — ${d.yesterdayLabel} recap`,
    `Added yesterday: ${d.addedYesterday.length} · Completed: ${d.doneYesterday.length} · Open: ${d.summary.open}`,
    d.focusToday ? `Focus today: ${d.focusToday.title}` : "Focus today: board is clear",
    d.url,
  ].join("\n");
}

export function buildDigestBlocks(d: DigestData): object[] {
  const focus = d.focusToday
    ? `${TYPE_EMOJI[d.focusToday.type]} *${d.focusToday.title}*${
        d.focusToday.customerSlug ? ` _(${d.focusToday.customerSlug})_` : ""
      }`
    : "_Board is clear — no open items to prioritize._";

  return [
    {
      type: "header",
      text: { type: "plain_text", text: "☀️  GTM Morning Digest", emoji: true },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Here's what moved on the board *${d.yesterdayLabel}*, and where to point today.`,
        },
      ],
    },
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*🆕 Added yesterday* (${d.addedYesterday.length})\n${bulletList(
          d.addedYesterday
        )}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*✅ Completed yesterday* (${d.doneYesterday.length})\n${bulletList(
          d.doneYesterday
        )}`,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*🎯 Focus today*\n${focus}` },
    },
    { type: "divider" },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `*${d.summary.open} open* · ${d.summary.suggested} suggested · ${d.summary.approved} approved · ${d.summary.done} done`,
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open the board", emoji: true },
          url: d.url,
          style: "primary",
        },
      ],
    },
  ];
}
