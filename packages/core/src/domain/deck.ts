export type DeckTentacleStatus = "idle" | "active" | "blocked" | "needs-review";

export type DeckOctopusAppearance = {
  animation: string | null;
  /** Valid: "normal" | "happy" | "angry" | "surprised". "sleepy" is reserved for idle state — never assign on creation. */
  expression: string | null;
  accessory: string | null;
  hairColor: string | null;
};

export type DeckAvailableSkill = {
  name: string;
  description: string;
  source: "project" | "user";
};

export type DeckTentacleWorktreeEntry = {
  repoName: string;
  /** ISO timestamp from deck state, or null if the worktree was discovered on
   * disk but has no persisted record (e.g. created out-of-band). */
  createdAt: string | null;
};

export type DeckTentacleSummary = {
  tentacleId: string;
  displayName: string;
  description: string;
  status: DeckTentacleStatus;
  color: string | null;
  octopus: DeckOctopusAppearance;
  scope: {
    paths: string[];
    tags: string[];
  };
  vaultFiles: string[];
  todoTotal: number;
  todoDone: number;
  todoItems: { text: string; done: boolean }[];
  suggestedSkills: string[];
  worktrees: DeckTentacleWorktreeEntry[];
};
