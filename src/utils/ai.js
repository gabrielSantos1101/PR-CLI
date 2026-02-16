import { GoogleGenerativeAI } from "@google/generative-ai";
import ora from "ora";
import { COMMIT_TYPES } from "../constants.js";
import { formatDiffsForAI } from "../services/commit.js";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

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
  const promptMode = isUpdate ? "UPDATE" : "CREATE";
  
  const prompt = `
You are an expert in writing Git Pull Request descriptions.
Your task is to ${isUpdate ? 'UPDATE an existing' : 'generate a new'} Pull Request description.

${isUpdate ? `
**UPDATE MODE:**
You are updating an existing PR description with new changes. The existing PR description is provided below.
Your task is to:
1. Keep all the existing content that is still relevant
2. Add information about the new changes from the new commit messages and diffs
3. Update sections that need to reflect the new changes
4. Maintain consistency with the existing description style and structure
5. Do NOT remove or overwrite existing content unless it's directly contradicted by new changes

Existing PR Description:
${existingPRDescription}

---

` : ''}

Here's the process:
1.  **Analyze Commit Messages:** Review the provided Git commit messages${isUpdate ? ' (these are NEW commits since the last update)' : ''}.
${commitDiffs ? '2.  **Analyze Code Changes:** Review the actual code diffs to understand what was modified, added, or removed.' : ''}
${commitDiffs ? '3.  **Synthesize Information:** Combine insights from both commit messages and code changes.' : '2.  **Fill Template Sections:** Use the information from the commit messages to fill in the relevant sections of the PR template.'}
${commitDiffs ? `4.  **${isUpdate ? 'Update' : 'Fill'} Template Sections:** ${isUpdate ? 'Update the existing PR description by adding information about new changes' : 'Use the information from both commit messages and code changes to fill in the relevant sections of the PR template'}.` : `3.  **Prioritize Clarity and Detail:** Ensure the generated content is easy to understand and provides sufficient detail for reviewers.`}
${commitDiffs ? '5.  **Prioritize Clarity and Detail:** Ensure the generated content is easy to understand and provides sufficient detail for reviewers.' : '4.  **Handle Missing Information:** If a section in the template cannot be directly filled by the commit messages, either leave it as is (if it\'s a placeholder like #ISSUE_NUMBER) or indicate that it\'s not applicable (e.g., "N/A" or "No relevant changes").'}
${commitDiffs ? '6.  **Handle Missing Information:** If a section in the template cannot be directly filled by the commit messages, either leave it as is (if it\'s a placeholder like #ISSUE_NUMBER) or indicate that it\'s not applicable (e.g., "N/A" or "No relevant changes").' : '5.  **Maintain Markdown Formatting:** Preserve the markdown structure of the template.'}
${commitDiffs ? '7.  **Maintain Markdown Formatting:** Preserve the markdown structure of the template.' : '6.  **Generate in the specified language:** The PR description should be generated in the language specified by \'templateLanguage\'.'}
${commitDiffs ? '8.  **Generate in the specified language:** The PR description should be generated in the language specified by \'templateLanguage\'.' : ''}

${isUpdate ? 'New ' : ''}Commit Messages:
${commitMessages.join("\n")}

${commitDiffs ? formatDiffsForAI(commitDiffs, commitMessages) : ''}

Developer's Description of ${isUpdate ? 'New ' : ''}Work:
${devDescription || "No additional description provided."}

${!isUpdate ? `PR Template (Language: ${templateLanguage}):
${templateContent}` : ''}

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
