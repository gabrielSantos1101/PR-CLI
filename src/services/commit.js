import { COMMIT_TYPES } from "../constants.js";

/**
 * Extracts the essential structure from a PR template (headings and key sections),
 * stripping boilerplate comments and placeholder text to reduce AI token usage.
 * @param {string} templateContent
 * @returns {string} The condensed template structure.
 */
export function extractTemplateStructure(templateContent) {
  const lines = templateContent.split("\n");
  const structure = [];
  let inComment = false;

  for (const line of lines) {
    if (line.trim().startsWith("<!--")) {
      inComment = true;
    }
    if (!inComment && line.trim().length > 0) {
      if (/^#{1,3}\s/.test(line) || /^- \[/.test(line) || /^---/.test(line)) {
        structure.push(line);
      }
    }
    if (inComment && line.trim().endsWith("-->")) {
      inComment = false;
    }
  }

  return structure.length > 0 ? structure.join("\n") : templateContent;
}

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
