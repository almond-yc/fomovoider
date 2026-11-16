import { z } from "zod";

// What the judge sees and returns. Kept free of Node APIs so tests and the
// eval script can build the same prompt.

export const JUDGE_MODEL = "gpt-6.1-sol";

// Most images one post may send to the model, across its own and its quoted
// post's media (video frames and GIF frames count one each).
export const MAX_IMAGES_PER_POST = 8;

export const SLOP_RUBRIC = `You judge one social media post for a person's Morning Brief: a short, calm digest of what actually matters from the people they follow on X and Instagram. Most of a feed is slop. Be strict: the brief is better with five real posts than with fifty.

Slop (tag it with these slugs in slopTags):
- engagement_bait: asks for likes, follows, reposts or comments; "reply with...", "who else...", polls made only for reach, giveaways for follows.
- rage_bait: built to provoke outrage or a pile-on rather than inform; dunking, culture-war bait, misleading screenshots.
- ai_filler: generic AI-generated text or images with nothing personal or new in them; motivational filler, "10 lessons" threads, AI art posted for reach.
- recycled: reposted memes, viral clips, screenshots of other platforms, old news recirculated, content the author didn't make and adds nothing to.
- ad: sponsored posts, product placement, affiliate links, self-promotion without substance, "link in bio".
- suggested: content from accounts the person doesn't follow, injected by the platform.
- low_effort_thread: padded threads and listicles with one idea stretched thin.
- clickbait: headlines or hooks that withhold the point to get a click.
- hustle: grindset, productivity porn, get-rich advice, crypto shilling.
- doomscroll: endless news churn with nothing the person can act on or would miss.

Not slop, and the reason the brief exists: real updates from people the person knows or follows on purpose (life updates, moves, new jobs, births, trips, events they're invited to or could go to), original work (writing, art, code, research, photos they took), genuinely useful information, announcements that matter, and real conversation.

Decide:
- isSlop and slopTags: whether the post is slop by the rubric above or by the person's own definition below. slopTags is empty when it isn't.
- matchesPreferences: whether it fits what the person said they want to see. With no stated preference, true when it isn't slop by their own definition.
- include: whether it belongs in today's brief. Never include slop. When in doubt, leave it out.
- priority: 0 to 1, how much the person would regret missing it. Life updates and events from people they know rank highest.
- reason: one short line, written to the person, saying why it's in or out (for example "Maya moved to Lisbon" or "Engagement bait").
- media: attach is whether showing the post's media helps; false for decorative, stock or AI images, memes on an otherwise useful post, or media that repeats the text. keepIndices lists the indices of the post's own media (media[i]) worth showing; empty when attach is false. Never list media the post doesn't have, and never quoted media.

Use the inspect_video tool when a video or GIF can't be judged from the frames you were given. Then submit your verdict.`;

export function buildSystemPrompt(input: { slopDescription?: string; wantToSee?: string }) {
  const parts = [SLOP_RUBRIC];
  parts.push(
    input.slopDescription?.trim()
      ? `What this person calls slop, in their own words:\n"""\n${input.slopDescription.trim()}\n"""`
      : "This person hasn't said what slop is for them; use the rubric.",
  );
  if (input.wantToSee?.trim()) {
    parts.push(`What this person wants to see more of, in their own words:\n"""\n${input.wantToSee.trim()}\n"""`);
  }
  return parts.join("\n\n");
}

export const VerdictSchema = z
  .object({
    isSlop: z.boolean(),
    slopTags: z.array(z.string()).describe("Rubric slugs, empty when not slop"),
    matchesPreferences: z.boolean(),
    include: z.boolean(),
    priority: z.number().min(0).max(1),
    reason: z.string().describe("One short line for the person"),
    media: z.object({
      attach: z.boolean(),
      keepIndices: z.array(z.number().int()).describe("Indices into the post's own media"),
      why: z.string(),
    }),
  })
  .meta({ title: "submit_verdict", description: "Submit the verdict for this post." });

export type Verdict = z.infer<typeof VerdictSchema>;

// Clamps what the model returned to what the post can carry: a priority in
// 0..1, and kept media that exists on the post, without duplicates.
export function sanitizeVerdict(verdict: Verdict, mediaCount: number): Verdict {
  const keepIndices = verdict.media.attach
    ? [...new Set(verdict.media.keepIndices)].filter((i) => Number.isInteger(i) && i >= 0 && i < mediaCount)
    : [];
  return {
    ...verdict,
    priority: Math.min(1, Math.max(0, verdict.priority)),
    reason: verdict.reason.trim().slice(0, 200),
    media: { ...verdict.media, attach: keepIndices.length > 0, keepIndices },
  };
}

export type PostContext = {
  platform: string;
  author: { handle: string; displayName: string };
  title?: string;
  text: string;
  createdAt: number;
  format?: "post" | "story";
  repostedBy?: { handle: string };
  replyTo?: { author?: { handle: string } };
  extracted?: {
    place?: { name: string };
    event?: { title?: string; startsAt?: number; place?: string };
    lifeUpdate?: string;
  };
  quoted?: { author: { handle: string; displayName: string }; title?: string; text: string };
  facts?: { sponsored: boolean; suggested: boolean; isReel: boolean; followsAuthor?: boolean };
};

// The post as text for the model. Its media follows as labelled images.
export function describePost(post: PostContext) {
  const lines = [
    `Platform: ${post.platform}`,
    `Author: ${post.author.displayName} (@${post.author.handle})`,
    `Posted: ${new Date(post.createdAt).toISOString()}`,
  ];
  if (post.format === "story") lines.push("Format: story");
  if (post.repostedBy) lines.push(`Reposted by @${post.repostedBy.handle}`);
  if (post.replyTo) lines.push(`In reply to ${post.replyTo.author ? `@${post.replyTo.author.handle}` : "a post"}`);
  if (post.facts) {
    lines.push(
      `Instagram says: sponsored=${post.facts.sponsored}, suggested=${post.facts.suggested}, reel=${post.facts.isReel}` +
        (post.facts.followsAuthor === undefined ? "" : `, follows author=${post.facts.followsAuthor}`),
    );
  }
  if (post.title) lines.push(`Title: ${post.title}`);
  const { extracted } = post;
  if (extracted?.lifeUpdate) lines.push(`Life update: ${extracted.lifeUpdate}`);
  if (extracted?.place) lines.push(`Place: ${extracted.place.name}`);
  if (extracted?.event) {
    const e = extracted.event;
    const when = e.startsAt ? new Date(e.startsAt).toISOString() : undefined;
    lines.push(`Event: ${[e.title, when, e.place].filter(Boolean).join(", ")}`);
  }
  lines.push("", "Text:", post.text || "(no text)");
  if (post.quoted) {
    lines.push(
      "",
      `Quoting ${post.quoted.author.displayName} (@${post.quoted.author.handle}):`,
      ...(post.quoted.title ? [`Title: ${post.quoted.title}`] : []),
      post.quoted.text || "(no text)",
    );
  }
  return lines.join("\n");
}
