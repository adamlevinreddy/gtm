import { NextRequest, NextResponse } from "next/server";
import { Sandbox } from "@vercel/sandbox";
import { WebClient } from "@slack/web-api";
import { kv } from "@vercel/kv";
import { buildPricingDriver, type PricingMeta } from "@/lib/pricing-agent";

export const maxDuration = 800;

export type PricingMode = "build" | "check";

type PricingThreadState = {
  sandboxName: string;
  mode: PricingMode;
  turnCount: number;
  company?: string;
  proposalDir?: string;
  createdAt: string;
  lastActivity: string;
};

const THREAD_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const SANDBOX_TIMEOUT_MS = 60 * 60 * 1000; // 60 min per session
const SNAPSHOT_EXPIRATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function sandboxNameFor(threadTs: string) {
  return `pricing-${threadTs.replace(/\./g, "_")}`;
}

export function pricingThreadKey(threadTs: string) {
  return `pricing:thread:${threadTs}`;
}

export async function POST(req: NextRequest) {
  const { mode, userText, slackChannel, slackThreadTs, slackUser } = (await req.json()) as {
    mode: PricingMode;
    userText: string;
    slackChannel: string;
    slackThreadTs: string;
    slackUser?: string;
  };

  const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
  const sandboxName = sandboxNameFor(slackThreadTs);
  const threadKey = pricingThreadKey(slackThreadTs);

  try {
    // Load or initialize thread state
    let state: PricingThreadState | null;
    try {
      state = await kv.get<PricingThreadState>(threadKey);
    } catch (kvErr) {
      throw new Error(`KV get failed: ${kvErr instanceof Error ? kvErr.message : String(kvErr)}`);
    }
    const isFirstTurn = !state;
    if (!state) {
      state = {
        sandboxName,
        mode,
        turnCount: 0,
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
      };
    }
    state.turnCount += 1;
    state.lastActivity = new Date().toISOString();

    // Get or create sandbox. Try persistent first; fall back to ephemeral if
    // persistent sandboxes are not enabled on this Vercel team.
    let sandbox: Sandbox;
    let persistentEnabled = true;
    try {
      sandbox = await Sandbox.get({ name: sandboxName, resume: true });
      console.log(`[pricing] Resumed sandbox ${sandboxName} (turn ${state.turnCount})`);
    } catch (getErr) {
      console.log(`[pricing] Sandbox.get miss (${getErr instanceof Error ? getErr.message : String(getErr)}) — creating`);
      try {
        sandbox = await Sandbox.create({
          name: sandboxName,
          resources: { vcpus: 4 },
          timeout: SANDBOX_TIMEOUT_MS,
          runtime: "node22",
          persistent: true,
          snapshotExpiration: SNAPSHOT_EXPIRATION_MS,
        });
        console.log(`[pricing] Created persistent sandbox ${sandbox.name}`);
      } catch (createPersistentErr) {
        console.warn(`[pricing] Persistent create failed (${createPersistentErr instanceof Error ? createPersistentErr.message : String(createPersistentErr)}) — falling back to ephemeral`);
        persistentEnabled = false;
        try {
          sandbox = await Sandbox.create({
            resources: { vcpus: 4 },
            timeout: SANDBOX_TIMEOUT_MS,
            runtime: "node22",
            persistent: false,
          });
          console.log(`[pricing] Created ephemeral sandbox ${sandbox.name}`);
        } catch (createErr) {
          throw new Error(`Sandbox.create failed (both persistent and ephemeral): ${createErr instanceof Error ? createErr.message : String(createErr)}`);
        }
      }
    }

    try {
      await sandbox.extendTimeout(SANDBOX_TIMEOUT_MS);
    } catch (extendErr) {
      console.warn(`[pricing] extendTimeout failed: ${extendErr instanceof Error ? extendErr.message : String(extendErr)}`);
    }

    // Write the latest user turn into the sandbox inbox
    const meta: PricingMeta = {
      mode: state.mode,
      sandboxName,
      slackChannel,
      slackThreadTs,
      slackUser: slackUser ?? null,
      threadKey,
      libraryRepoUrl: "github.com/ReddySolutions/pricing.git",
      isFirstTurn,
      turnCount: state.turnCount,
    };

    const turnPayload = {
      turnNumber: state.turnCount,
      receivedAt: new Date().toISOString(),
      userText,
      slackUser: slackUser ?? null,
    };

    const files = [
      {
        path: `inbox/turn-${state.turnCount}.json`,
        content: Buffer.from(JSON.stringify(turnPayload, null, 2)),
      },
      {
        path: "pricing-driver.mjs",
        content: Buffer.from(buildPricingDriver(meta)),
      },
    ];

    try {
      await sandbox.writeFiles(files);
    } catch (wfErr) {
      throw new Error(`writeFiles failed: ${wfErr instanceof Error ? wfErr.message : String(wfErr)}`);
    }

    // Detached run — function returns while driver works
    const cmd = await sandbox.runCommand({
      cmd: "node",
      args: ["pricing-driver.mjs", String(state.turnCount)],
      cwd: "/vercel/sandbox",
      detached: true,
      env: {
        ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh",
        ANTHROPIC_AUTH_TOKEN: process.env.AI_GATEWAY_API_KEY ?? "",
        SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN ?? "",
        SLACK_CHANNEL: slackChannel,
        SLACK_THREAD_TS: slackThreadTs,
        KV_REST_API_URL: process.env.KV_REST_API_URL ?? "",
        KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN ?? "",
        PRICING_LIBRARY_GITHUB_PAT: process.env.PRICING_LIBRARY_GITHUB_PAT ?? "",
        PRICING_THREAD_KEY: threadKey,
      },
    });

    // Persist thread state
    await kv.set(threadKey, state, { ex: THREAD_TTL_SECONDS });

    console.log(`[pricing] Driver started cmd=${cmd.cmdId} turn=${state.turnCount}`);

    return NextResponse.json({
      ok: true,
      sandboxName,
      turn: state.turnCount,
      cmdId: cmd.cmdId,
    });
  } catch (err) {
    console.error(`[pricing] Setup error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    await slack.reactions.remove({
      channel: slackChannel,
      name: "hammer_and_wrench",
      timestamp: slackThreadTs,
    }).catch(() => {});
    await slack.reactions.remove({
      channel: slackChannel,
      name: "mag",
      timestamp: slackThreadTs,
    }).catch(() => {});
    await slack.reactions.add({
      channel: slackChannel,
      name: "x",
      timestamp: slackThreadTs,
    }).catch(() => {});
    await slack.chat.postMessage({
      channel: slackChannel,
      thread_ts: slackThreadTs,
      text: `Pricing setup error: ${err instanceof Error ? err.message : String(err)}`,
    }).catch(() => {});
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
