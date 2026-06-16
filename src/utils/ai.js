import { GoogleGenerativeAI } from "@google/generative-ai";
import ora from "ora";
import { COMMIT_TYPES } from "../constants.js";
import { formatDiffsForAI } from "../services/commit.js";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: GEMINI_MODEL,
  generationConfig: {
    temperature: 0.2,
    maxOutputTokens: 4096,
  },
});

/**
 * Generates a suggested branch type using Google Gemini.
 * @param {string[]} commitMessages An array of raw commit messages.
 * @returns {Promise<string>} The AI-generated branch type.
 */
export async function generateAIBranchType(commitMessages) {
  if (!GEMINI_API_KEY) {
    console.warn(
      "GEMINI_API_KEY is not set. Skipping AI branch type generation."
    );
    return "feat";
  }

  const spinner = ora("Generating AI branch type...").start();
  const prompt = `
You are an expert in inferring Git conventional commit types from commit messages.
Your task is to suggest the most appropriate conventional commit type (e.g., "feat", "fix", "docs", "refactor", "chore", "style", "test", "perf", "ci", "build", "revert") based on the provided commit messages.

Rules:
1.  Return only the type string, without any additional text or formatting.
2.  If multiple types seem applicable, choose the most dominant one.
3.  If no clear type can be inferred, default to "feat".

Commit Messages:
${commitMessages.join("\n")}

Suggested Branch Type:
`;

  try {
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const generatedType = response.text().trim().toLowerCase();
    if (COMMIT_TYPES[generatedType]) {
      spinner.succeed("AI branch type generated.");
      return generatedType;
    }
    spinner.warn(
      "AI generated an unrecognized branch type. Falling back to 'feat'."
    );
    return "feat";
  } catch (error) {
    spinner.fail("Error generating AI branch type.");
    console.error("Error generating AI branch type:", error.message);
    return "feat";
  }
}

/**
 * Generates a full branch name using Google Gemini.
 * @param {string[]} commitMessages An array of raw commit messages.
 * @returns {Promise<string>} The AI-generated full branch name.
 */
export async function generateAIBranchName(commitMessages) {
  if (!GEMINI_API_KEY) {
    console.warn(
      "GEMINI_API_KEY is not set. Skipping AI branch name generation."
    );
    return "";
  }

  const spinner = ora("Generating AI branch name...").start();
  const prompt = `
You are an expert in generating very short, objective, kebab-cased Git branch names following conventional commit types.
Your task is to create a concise, descriptive branch name in the format "type/description-kebab-case" based on the provided commit messages.

Rules:
1.  The branch name must start with a conventional commit type (e.g., "feat", "fix", "docs", "refactor", "chore", "style", "test", "perf", "ci", "build", "revert"). Infer the most appropriate type from the commit messages.
2.  The description part should be in kebab-case (lowercase, words separated by hyphens).
3.  It must be very short and objective, reflecting the core purpose of the changes. Aim for 2-4 words for the description part.
4.  The entire branch name should be concise.
5.  Example: If commits are "Add user authentication and authorization", the output should be "feat/add-auth".
6.  Example: If commits are "Fix bug in login page where user couldn't log in", the output should be "fix/login-bug".
7.  Example: If commits are "Update README with new installation steps", the output should be "docs/update-readme".

Commit Messages:
${commitMessages.join("\n")}

Generated Branch Name (type/description-kebab-case):
`;

  try {
    const result = await model.generateContent(prompt);
    const response = result.response;
    const generatedName = response.text().trim();
    const parts = generatedName.split("/");
    if (parts.length === 2 && COMMIT_TYPES[parts[0]]) {
      spinner.succeed("AI branch name generated.");
      return generatedName;
    }
    spinner.warn(
      "AI generated an unrecognized branch name. Returning empty string."
    );
    return "";
  } catch (error) {
    spinner.fail("Error generating AI branch name.");
    console.error("Error generating AI branch name:", error.message);
    return "";
  }
}

/**
 * Generates content using Google Gemini based on commit messages and template.
 * @param {string[]} commitMessages An array of raw commit messages.
 * @param {string} templateContent The content of the chosen PR template.
 * @param {string} templateLanguage The language of the PR template.
 * @param {string} devDescription The developer's brief description.
 * @param {Array<{hash: string, content: string, truncated: boolean}>|null} commitDiffs Optional array of commit diffs.
 * @param {string|null} existingPRDescription Optional existing PR description.
 * @returns {Promise<string>} The AI-generated content for the PR description.
 */
export async function generateAIContent(
  commitMessages,
  templateContent,
  templateLanguage,
  devDescription,
  commitDiffs = null,
  existingPRDescription = null
) {
  if (!GEMINI_API_KEY) {
    console.warn("GEMINI_API_KEY is not set. Skipping AI content generation.");
    return "";
  }

  const spinner = ora("Generating AI-enhanced PR description...").start();

  const isUpdate = existingPRDescription !== null;

  const prompt = `
You are a senior Pull Request description analyst and editor.
Return only the final markdown PR description. Do not wrap it in code fences.

Goal:
${isUpdate ? "Update the existing PR description with the new changes." : "Fill the provided PR template with the changes."}

Style rules:
1. Be reviewer-focused: explain what changed, why it matters, how to verify it, and any risks or follow-ups.
2. Use the PR template as the canonical structure for the final description.
3. Preserve the template's headings, order, comments, checklist items, issue sections, and evidence sections.
4. Do not add new top-level headings unless the selected template has no place for essential reviewer context.
5. Use concise bullets, but include enough detail for a reviewer to understand the practical impact.
6. For small PRs, keep sections short. For large, cross-cutting, risky, or architectural PRs, use grouped bullets with subsystem names.
7. Do not invent details. Base content on commit messages, diffs, the existing PR body, and the developer description.
8. Avoid noisy file-by-file dumps, but name important files/modules when that helps reviewers navigate the change.
9. Keep placeholders or write "N/A" only when there is genuinely no evidence for that section.
10. Generate the content in this language: ${templateLanguage}.

Content judgment:
1. Prefer "useful and complete" over artificially short.
2. Include concrete testing steps when the template asks for tests, QA, validation, or evidence.
3. Include related issue references when provided by commits, existing content, or developer description.
4. Preserve checklist state from the template or existing PR; only check an item when the evidence supports it.
5. Mention limitations, known gaps, rollback notes, or follow-ups when the evidence points to them.
6. Summarize broad changes by concern or subsystem, not by every individual file.

PR Template (Language: ${templateLanguage}):
${templateContent}

${isUpdate ? `
Update mode rules:
1. Return the complete updated PR description, not a patch or summary.
2. Rebuild the final description in the same order and shape as the selected PR template.
3. Carry over existing filled content, manual notes, checklist states, placeholders, and issue tags that are still accurate.
4. Add only new, non-duplicated information from the new commits and diffs.
5. Remove or revise existing content only when contradicted by the new changes.
6. If existing content does not map to the template, keep it only when it is useful to reviewers and place it in the closest matching section.
7. If the existing PR was already detailed and accurate, preserve that level of useful detail instead of compressing it.

Existing PR Description:
${existingPRDescription}

---

` : ''}
Use commit messages and diffs as evidence. Produce a PR body that is proportional to the change size and review risk.

${isUpdate ? 'New ' : ''}Commit Messages:
${commitMessages.join("\n")}

${commitDiffs ? formatDiffsForAI(commitDiffs, commitMessages) : ''}

Developer's Description of ${isUpdate ? 'New ' : ''}Work:
${devDescription || "No additional description provided."}

Generated PR Description:
`;

  try {
    const result = await model.generateContent(prompt);
    const response = result.response;
    spinner.succeed("AI-enhanced PR description generated.");
    let generatedText = response.text().trim();
    if (
      generatedText.startsWith("```markdown") &&
      generatedText.endsWith("```")
    ) {
      generatedText = generatedText
        .substring(11, generatedText.length - 3)
        .trim();
    } else if (
      generatedText.startsWith("```") &&
      generatedText.endsWith("```")
    ) {
      generatedText = generatedText
        .substring(3, generatedText.length - 3)
        .trim();
    }
    return generatedText;
  } catch (error) {
    spinner.fail("Error generating AI content.");
    console.error("Error generating AI content:", error.message);
    
    const errorMsg = error.message.toLowerCase();
    if (errorMsg.includes('token') || errorMsg.includes('limit') || errorMsg.includes('too large') || errorMsg.includes('quota')) {
      console.warn("\n⚠ The error may be due to exceeding API token limits.");
      console.warn("   Suggestions:");
      console.warn("   1. Reduce the number of commits (use fewer commits in your PR)");
      console.warn("   2. Run without the --read flag to exclude diffs");
      console.warn("   3. Try again with a smaller commit range\n");
    }
    
    console.warn("Returning original template due to AI generation failure.");
    return `<!-- Error: AI content generation failed. Please review and fill manually. Details: ${error.message} -->\n\n${templateContent}`;
  }
}
