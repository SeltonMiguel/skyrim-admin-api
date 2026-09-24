// Closed catalog; each value is also enforced by a database CHECK.
export enum Profession {
  TAILOR = 'TAILOR',
  HUNTER = 'HUNTER',
  MINER = 'MINER',
  BLACKSMITH = 'BLACKSMITH',
  ALCHEMIST = 'ALCHEMIST',
  CHARCOAL_BURNER = 'CHARCOAL_BURNER',
  COOK = 'COOK',
}
export const MIN_PROFESSION_LEVEL = 1;
export const MAX_PROFESSION_LEVEL = 100;
// XP keeps accumulating after level 100 up to this safe integer ceiling
// (well below Number.MAX_SAFE_INTEGER); grants saturate there.
export const MAX_PROFESSION_EXPERIENCE = 1_000_000_000_000;
export const MAX_EXPERIENCE_GRANT = 1_000_000;

// Centralized, integer-only progression. Cumulative XP to reach level N is
// 100 * (N - 1)^2: level 1 = 0, 2 = 100, 3 = 400, ..., 100 = 980100.
export const ProfessionProgressionPolicy = {
  threshold(level: number): number {
    if (
      !Number.isInteger(level) ||
      level < MIN_PROFESSION_LEVEL ||
      level > MAX_PROFESSION_LEVEL
    )
      throw new RangeError('Invalid profession level');
    return 100 * (level - 1) ** 2;
  },
  levelFor(experience: number): number {
    if (
      !Number.isSafeInteger(experience) ||
      experience < 0 ||
      experience > MAX_PROFESSION_EXPERIENCE
    )
      throw new RangeError('Invalid profession experience');
    // Estimate, then correct with exact integer comparisons.
    let level = Math.min(
      MAX_PROFESSION_LEVEL,
      Math.floor(Math.sqrt(experience / 100)) + 1,
    );
    while (level > MIN_PROFESSION_LEVEL && this.threshold(level) > experience)
      level--;
    while (
      level < MAX_PROFESSION_LEVEL &&
      this.threshold(level + 1) <= experience
    )
      level++;
    return level;
  },
  nextLevelExperience(level: number): number | null {
    return level >= MAX_PROFESSION_LEVEL ? null : this.threshold(level + 1);
  },
  add(experience: number, amount: number): number {
    return Math.min(MAX_PROFESSION_EXPERIENCE, experience + amount);
  },
};

// Profession progress of a character (server + character id).
export interface ProfessionProgress {
  gameServerId: string;
  characterExternalId: string;
  profession: Profession;
  level: number;
  experience: number;
  nextLevelExperience: number | null;
}
// Trusted Agent grant result (Etapa 11 maps it to its transport).
export type ExperienceGrant =
  | { outcome: 'GRANTED'; progress: ProfessionProgress }
  | { outcome: 'ALREADY_APPLIED'; progress: ProfessionProgress }
  | {
      outcome: 'REJECTED';
      reason:
        | 'INVALID_INPUT'
        | 'PROFESSION_NOT_SELECTED'
        | 'PLAYER_UNAVAILABLE'
        | 'EVENT_CONFLICT';
    };
