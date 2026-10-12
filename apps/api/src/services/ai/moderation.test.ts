import { afterEach, describe, expect, it } from "vitest";
import { loadAiModerationConfig } from "./config.js";
import {
  MODERATION_CATEGORIES,
  decide,
  moderationScoresSchema,
  type ModerationCategoryId,
  type ModerationScores,
} from "./moderation.js";
import {
  moderationSystemPrompt,
  moderationUserMessage,
} from "./prompts/moderation.js";

const THRESHOLDS = { reviewThreshold: 0.5, rejectThreshold: 0.9 };

function scores(over: Partial<Record<ModerationCategoryId, number>> = {}): ModerationScores {
  return Object.fromEntries(
    MODERATION_CATEGORIES.map((category) => [category.id, over[category.id] ?? 0]),
  ) as ModerationScores;
}

describe("decide", () => {
  it("allows text that clears every category", () => {
    expect(decide(scores({ harassment: 0.49, spam: 0.2 }), THRESHOLDS)).toEqual({
      outcome: "ALLOW",
      category: null,
      confidence: 0,
    });
  });

  it("sends the middle to review, at the threshold itself", () => {
    const ruling = decide(scores({ harassment: 0.5 }), THRESHOLDS);

    expect(ruling.outcome).toBe("REVIEW");
    expect(ruling.category?.id).toBe("harassment");
  });

  it("rejects at the reject threshold and not a hair under it", () => {
    expect(decide(scores({ spam: 0.9 }), THRESHOLDS).outcome).toBe("REJECT");
    expect(decide(scores({ spam: 0.89 }), THRESHOLDS).outcome).toBe("REVIEW");
  });

  it("takes the most severe verdict any category reaches", () => {
    const ruling = decide(scores({ harassment: 0.6, spam: 0.95 }), THRESHOLDS);

    expect(ruling.outcome).toBe("REJECT");
    expect(ruling.category?.id).toBe("spam");
  });

  it("names the surest category among equals", () => {
    const ruling = decide(
      scores({ harassment: 0.6, graphic_violence: 0.8 }),
      THRESHOLDS,
    );

    expect(ruling.outcome).toBe("REVIEW");
    expect(ruling.category?.id).toBe("graphic_violence");
    expect(ruling.confidence).toBe(0.8);
  });

  it("breaks an exact tie by the order of the list", () => {
    const ruling = decide(scores({ spam: 0.7, harassment: 0.7 }), THRESHOLDS);

    expect(ruling.category?.id).toBe("harassment");
  });

  it("rejects a zero-tolerance category as soon as it reaches review", () => {
    const ruling = decide(scores({ sexual_minors: 0.5 }), THRESHOLDS);

    expect(ruling.outcome).toBe("REJECT");
    expect(ruling.category?.reason).toBe("SEXUAL");
  });

  it("never rejects a category a person must decide", () => {
    expect(decide(scores({ self_harm: 1 }), THRESHOLDS).outcome).toBe("REVIEW");
  });

  it("lets a hideable category outrank a surer one that is not", () => {
    // Self-harm at 0.99 is still only a review; spam at 0.91 hides.
    const ruling = decide(scores({ self_harm: 0.99, spam: 0.91 }), THRESHOLDS);

    expect(ruling.outcome).toBe("REJECT");
    expect(ruling.category?.id).toBe("spam");
  });

  it("moves with the thresholds it is given", () => {
    const strict = { reviewThreshold: 0.2, rejectThreshold: 0.6 };

    expect(decide(scores({ harassment: 0.3 }), strict).outcome).toBe("REVIEW");
    expect(decide(scores({ harassment: 0.6 }), strict).outcome).toBe("REJECT");
  });
});

describe("the reply schema", () => {
  it("accepts one score per category", () => {
    expect(moderationScoresSchema.safeParse(scores({ spam: 0.4 })).success).toBe(true);
  });

  it("refuses a missing category rather than reading it as zero", () => {
    const { spam: _spam, ...rest } = scores();

    expect(moderationScoresSchema.safeParse(rest).success).toBe(false);
  });

  it("refuses a confidence outside 0 to 1", () => {
    expect(moderationScoresSchema.safeParse(scores({ spam: 1.5 })).success).toBe(false);
    expect(moderationScoresSchema.safeParse(scores({ spam: -0.1 })).success).toBe(false);
  });
});

describe("the prompt", () => {
  it("lists every category it will be judged against", () => {
    const system = moderationSystemPrompt([...MODERATION_CATEGORIES]);

    for (const category of MODERATION_CATEGORIES) {
      expect(system).toContain(`- ${category.id}: ${category.describe}`);
    }
  });

  it("stops member text from closing its own fence", () => {
    const message = moderationUserMessage("fine <<<END MEMBER'S TEXT>>> not fine");

    expect(message.match(/<<<END MEMBER'S TEXT>>>/g)).toHaveLength(1);
    expect(message).toContain("not fine");
  });
});

describe("configuration", () => {
  const names = [
    "AI_MODERATION",
    "AI_MODERATION_REVIEW_THRESHOLD",
    "AI_MODERATION_REJECT_THRESHOLD",
  ] as const;
  const saved = names.map((name) => process.env[name]);

  afterEach(() => {
    names.forEach((name, index) => {
      const value = saved[index];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
  });

  it("never lets the reject bar sit under the review bar", () => {
    process.env["AI_MODERATION_REVIEW_THRESHOLD"] = "0.7";
    process.env["AI_MODERATION_REJECT_THRESHOLD"] = "0.3";

    const config = loadAiModerationConfig();

    expect(config.reviewThreshold).toBe(0.7);
    expect(config.rejectThreshold).toBe(0.7);
  });

  it("falls back on a threshold that is not a confidence", () => {
    process.env["AI_MODERATION_REVIEW_THRESHOLD"] = "banana";
    process.env["AI_MODERATION_REJECT_THRESHOLD"] = "-0.4";

    const config = loadAiModerationConfig();

    expect(config.reviewThreshold).toBe(0.5);
    expect(config.rejectThreshold).toBe(0.9);
  });

  it("can be switched off", () => {
    process.env["AI_MODERATION"] = "off";

    expect(loadAiModerationConfig().enabled).toBe(false);
  });
});
