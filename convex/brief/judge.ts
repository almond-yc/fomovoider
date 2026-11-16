"use node";

import { ChatOpenAI } from "@langchain/openai";
import { NonRetryableError } from "@convex-dev/workpool";
import { v } from "convex/values";
import { AIMessage, createAgent, HumanMessage, tool, toolStrategy } from "langchain";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { z } from "zod";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { extractFrames, prepareMedia, type PreparedMedia } from "./media";
import {
  buildSystemPrompt,
  describePost,
  JUDGE_MODEL,
  sanitizeVerdict,
  VerdictSchema,
  type PostContext,
  type Verdict,
} from "./prompt";

// The judge: a LangChain agent that looks at one post (text plus frames) and
// returns a verdict. It's an agent and not a single call because of
// inspect_video, which pulls more frames when the first ones aren't enough.

const MAX_INSPECT_FRAMES = 6;
const RECURSION_LIMIT = 12;

export type JudgeInput = {
  post: PostContext & { media: { kind: "image" | "video" | "gif"; url: string; previewUrl?: string; altText?: string; durationSec?: number }[]; quoted?: PostContext["quoted"] & { media: { kind: "image" | "video" | "gif"; url: string; previewUrl?: string; altText?: string; durationSec?: number }[] } };
  slopDescription?: string;
  wantToSee?: string;
};

export type JudgeResult = {
  verdict: Verdict;
  usage: { inputTokens: number; outputTokens: number; modelCalls: number; inspectVideoCalls: number };
  framesSent: number;
};

export function createJudgeModel(): BaseChatModel {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new NonRetryableError("OPENAI_API_KEY is not set on this deployment");
  // No client retries: the workpool retries the whole post with backoff, which
  // is what spaces out 429s.
  return new ChatOpenAI({ model: JUDGE_MODEL, apiKey, useResponsesApi: true, maxRetries: 0 });
}

function mediaBlocks(media: PreparedMedia[]) {
  const blocks: ({ type: "text"; text: string } | { type: "image"; mimeType: string; data: string })[] = [];
  for (const m of media) {
    const head = `${m.source === "post" ? `media[${m.index}]` : `quoted media[${m.index}]`} (${m.kind}${m.durationSec ? `, ${m.durationSec.toFixed(1)}s` : ""}, ref "${m.ref}")`;
    blocks.push({
      type: "text",
      text: [head, m.altText ? `alt text: ${m.altText}` : undefined, m.note].filter(Boolean).join(" - "),
    });
    for (const f of m.frames) {
      blocks.push({ type: "text", text: f.label });
      blocks.push({ type: "image", mimeType: f.mimeType, data: f.data });
    }
  }
  return blocks;
}

// Runs the agent on one post. model is injectable so tests and the eval
// script share this path with production.
export async function judge(input: JudgeInput, model: BaseChatModel): Promise<JudgeResult> {
  const prepared = await prepareMedia(input.post);
  try {
    const inspectVideo = tool(
      async ({ ref, startSec, endSec, count }) => {
        const m = prepared.media.find((x) => x.ref === ref);
        if (!m?.file) return `No video or GIF with ref "${ref}" is available.`;
        const end = Math.min(endSec ?? m.durationSec ?? 1, m.durationSec ?? endSec ?? 1);
        const frames = await extractFrames(m.file, prepared.dir, {
          count: Math.min(count ?? 4, MAX_INSPECT_FRAMES),
          start: Math.max(0, startSec ?? 0),
          end,
          label: `${ref}`,
        });
        return [
          { type: "text" as const, text: `${frames.length} more frames from ${ref}: ${frames.map((f) => f.label).join(", ")}` },
          ...frames.map((f) => ({ type: "image" as const, mimeType: f.mimeType, data: f.data })),
        ];
      },
      {
        name: "inspect_video",
        description: "Extract more frames from one of the post's videos or GIFs, evenly spaced between startSec and endSec.",
        schema: z.object({
          ref: z.string().describe('The media ref, e.g. "m0"'),
          startSec: z.number().optional(),
          endSec: z.number().optional(),
          count: z.number().int().min(1).max(MAX_INSPECT_FRAMES).optional(),
        }),
      },
    );
    const agent = createAgent({
      model,
      tools: [inspectVideo],
      systemPrompt: buildSystemPrompt(input),
      responseFormat: toolStrategy(VerdictSchema),
    });
    const blocks = [{ type: "text" as const, text: describePost(input.post) }, ...mediaBlocks(prepared.media)];
    const result = await agent.invoke(
      { messages: [new HumanMessage({ contentBlocks: blocks })] },
      { recursionLimit: RECURSION_LIMIT },
    );
    const usage = { inputTokens: 0, outputTokens: 0, modelCalls: 0, inspectVideoCalls: 0 };
    for (const message of result.messages) {
      // toolStrategy appends its own AIMessage after the verdict; only the
      // model's turns carry tool calls.
      if (!AIMessage.isInstance(message) || !message.tool_calls?.length) continue;
      usage.modelCalls += 1;
      usage.inspectVideoCalls += message.tool_calls.filter((c) => c.name === "inspect_video").length;
      usage.inputTokens += message.usage_metadata?.input_tokens ?? 0;
      usage.outputTokens += message.usage_metadata?.output_tokens ?? 0;
    }
    return {
      verdict: sanitizeVerdict(result.structuredResponse as Verdict, input.post.media.length),
      usage,
      framesSent: prepared.media.reduce((n, m) => n + m.frames.length, 0),
    };
  } finally {
    await prepared.cleanup();
  }
}

// One post, run by the judge pool (workflow.ts). Throws on model errors so the
// pool retries with backoff; saveVerdict keeps the first verdict per post.
export const judgePost = internalAction({
  args: { runId: v.id("brief_runs"), postId: v.id("posts") },
  returns: v.null(),
  handler: async (ctx, { runId, postId }) => {
    const input = await ctx.runQuery(internal.brief.workflow.judgeInput, { postId });
    if (input === null) return null;
    const { verdict, usage, framesSent } = await judge(input, createJudgeModel());
    console.log("brief judge", JSON.stringify({ postId, include: verdict.include, framesSent, ...usage }));
    await ctx.runMutation(internal.brief.workflow.saveVerdict, { runId, postId, verdict, model: JUDGE_MODEL });
    return null;
  },
});
