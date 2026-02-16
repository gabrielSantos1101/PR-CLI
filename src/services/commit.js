import { COMMIT_TYPES } from "../constants.js";

/**
 * Categorizes commit messages based on conventional commit prefixes.
 * @param {string[]} commitMessages An array of raw commit messages.
 * @returns {Object.<string, string[]>}
 */
export function categorizeCommits(commitMessages) {
  const categorized = {};

  for (const message of commitMessages) {
    const match = message.match(/^(\w+)(\(.+\))?: (.+)$/);
    if (match) {
      const type = match[1];
      const description = match[3];
      const section = COMMIT_TYPES[type];

      if (section) {
        if (!categorized[section]) {
          categorized[section] = [];
        }
        categorized[section].push(`- ${description}`);
      } else {
        if (!categorized["Other Changes"]) {
          categorized["Other Changes"] = [];
        }
        categorized["Other Changes"].push(`- ${message}`);
      }
    } else {
      if (!categorized["Other Changes"]) {
        categorized["Other Changes"] = [];
      }
      categorized["Other Changes"].push(`- ${message}`);
    }
  }
  return categorized;
}

/**
 * Formats commit diffs for AI prompt inclusion.
 * @param {Array<{hash: string, content: string, truncated: boolean}>} diffs Array of diff objects.
 * @param {string[]} commitMessages Array of commit messages.
 * @returns {string} Formatted string with diffs in markdown code blocks.
 */
export function formatDiffsForAI(diffs, commitMessages) {
  let formatted = "\n\n=== CODE CHANGES ===\n\n";
  
  diffs.forEach((diff, index) => {
    formatted += `Commit ${index + 1}: ${commitMessages[index]}\n`;
    formatted += `Hash: ${diff.hash}\n`;
    formatted += `\`\`\`diff\n${diff.content}\n\`\`\`\n\n`;
    
    if (diff.truncated) {
      formatted += "[Note: This diff was truncated due to size limits]\n\n";
    }
  });
  
  return formatted;
}
