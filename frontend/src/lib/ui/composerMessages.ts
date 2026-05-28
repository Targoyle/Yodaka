const COMPOSER_WELCOME_MESSAGES: readonly string[] = [
  "Sabotenism :)",
];

export function pickComposerWelcomeMessage(random = Math.random) {
  if (COMPOSER_WELCOME_MESSAGES.length === 0) {
    return null;
  }

  const sampled = random();
  const normalized = Number.isFinite(sampled) ? sampled : 0;
  const clamped = Math.min(Math.max(normalized, 0), 0.999999999999);
  const index = Math.floor(clamped * COMPOSER_WELCOME_MESSAGES.length);

  return COMPOSER_WELCOME_MESSAGES[index] ?? COMPOSER_WELCOME_MESSAGES[0];
}
