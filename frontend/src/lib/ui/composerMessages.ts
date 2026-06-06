type ComposerWelcomeMessage = {
  message: string;
  probability: number;
};

const COMPOSER_WELCOME_MESSAGES: readonly ComposerWelcomeMessage[] = [
  {
    message: "Sabotenism :)",
    probability: 0.9,
  },
  {
    message: "Are You Sabotenic Yet?",
    probability: 0.1,
  },
];

export function pickComposerWelcomeMessage(random = Math.random) {
  if (COMPOSER_WELCOME_MESSAGES.length === 0) {
    return null;
  }

  const sampled = random();
  const normalized = Number.isFinite(sampled) ? sampled : 0;
  const clamped = Math.min(Math.max(normalized, 0), 0.999999999999);
  const totalProbability = COMPOSER_WELCOME_MESSAGES.reduce(
    (sum, entry) => sum + Math.max(entry.probability, 0),
    0,
  );

  if (totalProbability <= 0) {
    return COMPOSER_WELCOME_MESSAGES[0]?.message ?? null;
  }

  const target = clamped * totalProbability;
  let cumulative = 0;

  for (const entry of COMPOSER_WELCOME_MESSAGES) {
    cumulative += Math.max(entry.probability, 0);

    if (target < cumulative) {
      return entry.message;
    }
  }

  return COMPOSER_WELCOME_MESSAGES.at(-1)?.message ?? COMPOSER_WELCOME_MESSAGES[0]?.message ?? null;
}
