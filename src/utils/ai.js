import { GoogleGenerativeAI } from "@google/generative-ai";
import ora from "ora";
import { COMMIT_TYPES } from "../constants.js";
import { formatDiffsForAI, extractTemplateStructure } from "../services/commit.js";

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
 * Heuristically infers the dominant conventional commit type from commit messages.
 * @param {string[]} commitMessages
 * @returns {string} The inferred branch type (e.g., "feat", "fix").
 */
export function suggestBranchType(commitMessages) {
  const typeCount = {};
  for (const msg of commitMessages) {
    const match = msg.match(/^(\w+)/);
    if (match && COMMIT_TYPES[match[1]]) {
      typeCount[match[1]] = (typeCount[match[1]] || 0) + 1;
    }
  }

  let bestType = "feat";
  let bestCount = 0;
  for (const [type, count] of Object.entries(typeCount)) {
    if (count > bestCount) {
      bestType = type;
      bestCount = count;
    }
  }
  return bestType;
}

/**
 * Suggests a branch name using heuristic when AI is unavailable.
 * @param {string[]} commitMessages
 * @returns {string} A branch name like "fix/login-error".
 */
function suggestBranchName(commitMessages) {
  const type = suggestBranchType(commitMessages);

  const words = [];
  for (const msg of commitMessages) {
    const cleaned = msg
      .replace(/^(\w+)(\(.+\))?:\s*/i, "")
      .replace(/[^a-zA-Z0-9\s]/g, "")
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2 && !["the", "and", "for", "with", "this", "that"].includes(w));
    words.push(...cleaned);
  }

  const uniqueWords = [...new Set(words)];
  const shortDesc = uniqueWords.slice(0, 3).join("-") || "change";
  return `${type}/${shortDesc}`;
}

/**
 * Generates a suggested branch type using Google Gemini, with heuristic fallback.
 * @param {string[]} commitMessages An array of raw commit messages.
 * @returns {Promise<string>} The generated branch type.
 */
export async function generateAIBranchType(commitMessages) {
  if (!GEMINI_API_KEY) {
    console.warn(
      "GEMINI_API_KEY is not set. Using heuristic to infer branch type."
    );
    return suggestBranchType(commitMessages);
  }

  const spinner = ora("Generating AI branch type...").start();
  const prompt = `
You are an expert in inferring Git conventional commit types from commit messages.
Return only the type string (e.g., "feat", "fix", "docs", "refactor", "chore", "style", "test", "perf", "ci", "build", "revert"). No extra text.

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
      "AI generated an unrecognized branch type. Falling back to heuristic."
    );
    return suggestBranchType(commitMessages);
  } catch (error) {
    spinner.fail("Error generating AI branch type.");
    console.error("Error generating AI branch type:", error.message);
    return suggestBranchType(commitMessages);
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
      "GEMINI_API_KEY is not set. Using heuristic to generate branch name."
    );
    return suggestBranchName(commitMessages);
  }

  const spinner = ora("Generating AI branch name...").start();
  const prompt = `
You are an expert in generating very short, objective, kebab-cased Git branch names following conventional commit types.
Create a concise branch name in the format "type/description-kebab-case" based on the provided commit messages.

Rules:
1. Start with a conventional commit type (e.g., "feat", "fix", "docs", "refactor", "chore", "style", "test", "perf", "ci", "build", "revert").
2. Description in kebab-case, 2-4 words.
3. Examples: "feat/add-auth", "fix/login-bug", "docs/update-readme".

Commit Messages:
${commitMessages.join("\n")}

Generated Branch Name:
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
      "AI generated an unrecognized branch name. Falling back to heuristic."
    );
    return suggestBranchName(commitMessages);
  } catch (error) {
    spinner.fail("Error generating AI branch name.");
    console.error("Error generating AI branch name:", error.message);
    return suggestBranchName(commitMessages);
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
You are a senior Pull Request description writer. Return only the final markdown PR description. Do not wrap it in code fences.

Goal:
${isUpdate ? "Update the existing PR description with the new changes." : "Write a PR description based on the commits below."}

Guidelines:
1. Start with a short (1-3 sentence) summary of what this PR does and why.
2. List the changes as concise bullet points grouped by concern or theme — not by file or commit.
3. If relevant, include brief testing instructions (what to verify, not how to run tests).
4. Mention any important notes: breaking changes, dependencies, or follow-up work.
5. Write in ${templateLanguage}.
6. Keep it focused and useful — avoid filler, placeholders, or empty sections.
7. Base content only on the evidence provided (commits, diffs, developer description).

${templateContent ? `Use this template structure (fill only sections where you have content — remove empty ones):

${extractTemplateStructure(templateContent)}
` : ''}
${isUpdate ? `
Existing PR to update (preserve any accurate content, add new information):

${existingPRDescription}
` : ''}

Commit Messages:
${commitMessages.join("\n")}

${commitDiffs ? formatDiffsForAI(commitDiffs, commitMessages) : ''}

Developer's Description:
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
