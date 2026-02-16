/**
 * Mapping of conventional commit types to their corresponding PR section titles.
 * @type {Object.<string, string>}
 */
export const COMMIT_TYPES = {
  feat: "Features",
  fix: "Bug Fixes",
  refactor: "Refactors",
  chore: "Chores",
  docs: "Documentation",
  style: "Styling",
  test: "Tests",
  perf: "Performance Improvements",
  ci: "CI/CD",
  build: "Build System",
  revert: "Reverts",
};

export const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000;
