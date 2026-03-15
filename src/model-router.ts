/**
 * Smart Model Router — classifies messages and picks the right model tier.
 *
 * Opus for hypothesis generation / experimental design / complex reasoning.
 * Haiku for quick lookups, definitions, short questions.
 * Sonnet (default) for everything else.
 */

import type { NewMessage, RegisteredGroup } from './types.js';

interface Rule {
  pattern: RegExp;
  weight: number;
}

export const OPUS_RULES: Rule[] = [
  // Experimental design / hypothesis
  { pattern: /\b(design|propose)\s+(an?\s+)?experiment/i, weight: 3 },
  { pattern: /\bhypothesis\b/i, weight: 2 },
  { pattern: /\bhypotheses\b/i, weight: 2 },
  { pattern: /\bmechanism(s)?\s+(by which|underlying|behind)\b/i, weight: 2 },

  // Complex analytical reasoning
  {
    pattern: /\bcritical(ly)?\s+(analyze|assess|evaluate|review)\b/i,
    weight: 2,
  },
  { pattern: /\bcompare\s+and\s+contrast\b/i, weight: 2 },
  { pattern: /\bsystematic(ally)?\s+(review|analysis)\b/i, weight: 2 },
  { pattern: /\bmeta[\s-]?analysis\b/i, weight: 2 },

  // Multi-step reasoning markers
  { pattern: /\bstep[\s-]by[\s-]step\b/i, weight: 1 },
  { pattern: /\bin[\s-]depth\b/i, weight: 1 },
  { pattern: /\bcomprehensive(ly)?\b/i, weight: 1 },
  { pattern: /\bthorough(ly)?\b/i, weight: 1 },

  // Domain-specific complex tasks (biology/research)
  { pattern: /\bexperimental\s+design\b/i, weight: 3 },
  { pattern: /\bsignaling\s+(pathway|cascade|network)\b/i, weight: 1 },
  { pattern: /\btranscription(al)?\s+regulation\b/i, weight: 1 },
  { pattern: /\bepigenetic\b/i, weight: 1 },
  { pattern: /\bendothelial[\s-]to[\s-]mesenchymal\b/i, weight: 1 },

  // Long messages are more likely to need opus (weight applied via length bonus)
];

export const HAIKU_RULES: Rule[] = [
  // Definitions / quick lookups
  { pattern: /^what\s+is\s+\S+\??\s*$/i, weight: 3 },
  { pattern: /^what\s+does\s+\S+\s+(stand\s+for|mean)\??\s*$/i, weight: 3 },
  { pattern: /^define\s+\S+\s*$/i, weight: 3 },
  { pattern: /\bdefin(e|ition)\s+of\b/i, weight: 2 },

  // Simple gene/protein lookups
  { pattern: /^(what|where)\s+is\s+[A-Z][A-Z0-9]{1,10}\??\s*$/i, weight: 2 },
  { pattern: /\bfull\s+name\s+(of|for)\b/i, weight: 2 },
  { pattern: /\bacronym\b/i, weight: 1 },

  // Yes/no and simple factual questions
  { pattern: /^(is|does|can|has|are)\s+\S+/i, weight: 1 },
  { pattern: /\bhow\s+many\b/i, weight: 1 },
  { pattern: /\blist\s+(the\s+)?(all\s+)?/i, weight: 1 },

  // Short conversational
  {
    pattern: /^(thanks|thank you|ok|yes|no|got it|sure)\s*[.!]?\s*$/i,
    weight: 3,
  },
];

export const OPUS_THRESHOLD = 4;
export const HAIKU_THRESHOLD = 3;

export type ModelTier = 'opus' | 'sonnet' | 'haiku';

export interface ClassificationResult {
  tier: ModelTier;
  opusScore: number;
  haikuScore: number;
}

export interface ModelResult {
  modelId: string;
  autoRouted: boolean;
  tier: ModelTier;
}

const TIER_TO_MODEL: Record<ModelTier, string> = {
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};

function scoreMessage(content: string, rules: Rule[]): number {
  let score = 0;
  for (const rule of rules) {
    if (rule.pattern.test(content)) {
      score += rule.weight;
    }
  }
  return score;
}

/**
 * Classify an array of messages into a model tier.
 * The last message gets 1.5x weight since it's the active request.
 */
export function classifyMessages(
  messages: Pick<NewMessage, 'content'>[],
): ClassificationResult {
  if (messages.length === 0) {
    return { tier: 'sonnet', opusScore: 0, haikuScore: 0 };
  }

  let opusScore = 0;
  let haikuScore = 0;

  for (let i = 0; i < messages.length; i++) {
    const content = messages[i].content;
    const isLast = i === messages.length - 1;
    const multiplier = isLast ? 1.5 : 1;

    opusScore += scoreMessage(content, OPUS_RULES) * multiplier;
    haikuScore += scoreMessage(content, HAIKU_RULES) * multiplier;

    // Length bonus for opus: messages over 200 chars suggest complex requests
    if (isLast && content.length > 200) {
      opusScore += 1;
    }
  }

  let tier: ModelTier = 'sonnet';
  if (opusScore >= OPUS_THRESHOLD) {
    tier = 'opus';
  } else if (haikuScore >= HAIKU_THRESHOLD && opusScore < OPUS_THRESHOLD) {
    tier = 'haiku';
  }

  return { tier, opusScore, haikuScore };
}

/**
 * Resolve the model for a group invocation.
 * Returns the model to use and whether auto-routing was applied.
 */
export function resolveModel(
  group: RegisteredGroup,
  messages: Pick<NewMessage, 'content'>[],
): ModelResult {
  const config = group.containerConfig;

  // Auto-routing must be explicitly enabled
  if (!config?.autoRoute) {
    const currentModel = config?.model || TIER_TO_MODEL.sonnet;
    return { modelId: currentModel, autoRouted: false, tier: 'sonnet' };
  }

  // If model is pinned, don't auto-route
  if (config.modelPinned) {
    const currentModel = config.model || TIER_TO_MODEL.sonnet;
    return { modelId: currentModel, autoRouted: false, tier: 'sonnet' };
  }

  const classification = classifyMessages(messages);
  const defaultModel = config.model || TIER_TO_MODEL.sonnet;
  const routedModel = TIER_TO_MODEL[classification.tier];

  // Only report autoRouted if we're changing from the default
  const autoRouted = routedModel !== defaultModel;

  return {
    modelId: routedModel,
    autoRouted,
    tier: classification.tier,
  };
}
