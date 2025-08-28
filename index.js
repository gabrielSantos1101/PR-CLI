#!/usr/bin/env node

const { exec } = require("child_process");
const fs = require("fs").promises;
const path = require("path");
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");
const inquirer = require("inquirer");
const clipboardy = require("clipboardy");
const { GoogleGenerativeAI } = require("@google/generative-ai");

/**
 * Google Gemini API Key.
 * @type {string}
 */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
/**
 * Google Generative AI instance.
 * @type {GoogleGenerativeAI}
 */
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
/**
 * Generative AI model instance.
 * @type {import('@google/generative-ai').GenerativeModel}
 */
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

/**
 * Mapping of conventional commit types to their corresponding PR section titles.
 * @type {Object.<string, string>}
 */
const COMMIT_TYPES = {
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

/**
 * Executes a shell command and returns its output.
 * @param {string} command The command to execute.
 * @returns {Promise<string>} The command's stdout.
 */
async function executeCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`exec error: ${error}`);
        return reject(error);
      }
      if (stderr) {
        console.error(`stderr: ${stderr}`);
      }
      resolve(stdout.trim());
    });
  });
}

/**
 * Gets the Git commit history from the current branch up to the last push.
 * It compares the current branch's HEAD with its upstream branch on origin.
 * @returns {Promise<string[]>} An array of commit messages. Returns an empty array if no commits are found or an error occurs.
 */
async function getCommitHistory() {
  try {
    const currentBranch = await executeCommand(
      "git rev-parse --abbrev-ref HEAD"
    );
    const lastPushCommit = await executeCommand(
      `git merge-base ${currentBranch} origin/${currentBranch}`
    );
    const commitLogs = await executeCommand(
      `git log ${lastPushCommit}..HEAD --pretty=format:"%s"`
    );
    return commitLogs.split("\n").filter(Boolean);
  } catch (error) {
    console.error(
      "Failed to get Git commit history. Ensure you are in a Git repository and have pushed to origin."
    );
    return [];
  }
}

/**
 * Categorizes commit messages based on conventional commit prefixes (e.g., "feat:", "fix:").
 * Messages without a recognized prefix are grouped under "Other Changes".
 * @param {string[]} commitMessages An array of raw commit messages.
 * @returns {Object.<string, string[]>} An object where keys are PR sections (e.g., "Features", "Bug Fixes") and values are arrays of formatted commit messages.
 */
function categorizeCommits(commitMessages) {
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
 * Checks for Pull Request templates in the `.github` folder and its `PULL_REQUEST_TEMPLATE` subdirectory.
 * It looks for Markdown files (`.md`).
 * @returns {Promise<string[]>} An array of template file paths. Returns an empty array if no templates are found.
 */
async function getPRTemplates() {
  const githubPath = path.join(process.cwd(), ".github");
  const templateDirPath = path.join(githubPath, "PULL_REQUEST_TEMPLATE");
  const templates = [];

  try {
    // Check .github/PULL_REQUEST_TEMPLATE/
    const templateDirExists = await fs
      .stat(templateDirPath)
      .then((stat) => stat.isDirectory())
      .catch(() => false);
    if (templateDirExists) {
      const files = await fs.readdir(templateDirPath);
      for (const file of files) {
        if (file.endsWith(".md")) {
          templates.push(path.join(templateDirPath, file));
        }
      }
    }

    // If no templates found in subdirectory, check .github/
    if (templates.length === 0) {
      const githubDirExists = await fs
        .stat(githubPath)
        .then((stat) => stat.isDirectory())
        .catch(() => false);
      if (githubDirExists) {
        const files = await fs.readdir(githubPath);
        for (const file of files) {
          if (
            file.endsWith(".md") &&
            file.toLowerCase().includes("pull_request_template")
          ) {
            templates.push(path.join(githubPath, file));
          }
        }
      }
    }
  } catch (error) {
    // Ignore errors if directories don't exist
  }
  return templates;
}

/**
 * Prompts the user to choose a PR template from a list of available templates.
 * If only one template is available, it's automatically selected.
 * @param {string[]} templates An array of template file paths.
 * @returns {Promise<string|null>} The content of the chosen template, or `null` if no template is chosen or available.
 */
async function chooseTemplate(templates) {
  if (templates.length === 0) {
    return null;
  }

  if (templates.length === 1) {
    console.log(
      `Automatically selecting the only available template: ${path.basename(
        templates[0]
      )}`
    );
    return fs.readFile(templates[0], "utf-8");
  }

  const choices = templates.map((tplPath) => ({
    name: path.basename(tplPath),
    value: tplPath,
  }));

  const { selectedTemplatePath } = await inquirer.default.prompt([
    {
      type: "list",
      name: "selectedTemplatePath",
      message: "Select a PR template:",
      choices: [{ name: "No template", value: null }, ...choices],
      default: null,
    },
  ]);

  if (selectedTemplatePath) {
    return fs.readFile(selectedTemplatePath, "utf-8");
  }
  return null;
}

/**
 * Generates the PR description based on categorized commits and an optional template.
 * It formats the categorized commits into sections and prepends them to the template content if provided.
 * @param {Object.<string, string[]>} categorizedCommits Categorized commit messages.
 * @param {string|null} templateContent Optional content from a PR template.
 * @returns {string} The formatted PR description.
 */
function generatePRDescription(categorizedCommits, templateContent = null) {
  let prBody = "";

  if (templateContent) {
    prBody += templateContent + "\n\n---\n\n";
  }

  for (const section in COMMIT_TYPES) {
    const sectionTitle = COMMIT_TYPES[section];
    if (
      categorizedCommits[sectionTitle] &&
      categorizedCommits[sectionTitle].length > 0
    ) {
      prBody += `### ${sectionTitle}\n\n`;
      prBody += categorizedCommits[sectionTitle].join("\n") + "\n\n";
    }
  }

  if (
    categorizedCommits["Other Changes"] &&
    categorizedCommits["Other Changes"].length > 0
  ) {
    prBody += `### Other Changes\n\n`;
    prBody += categorizedCommits["Other Changes"].join("\n") + "\n\n";
  }

  return prBody.trim();
}

/**
 * Generates content using Google Gemini based on commit messages and a template.
 * This function constructs a prompt for the AI to generate a PR description by filling
 * the provided template with information extracted from commit messages.
 * @param {string[]} commitMessages An array of raw commit messages.
 * @param {string} templateContent The content of the chosen PR template.
 * @param {string} templateLanguage The language of the PR template (e.g., "en", "pt").
 * @returns {Promise<string>} The AI-generated content for the PR description. Returns a fallback comment if AI generation fails.
 */
async function generateAIContent(
  commitMessages,
  templateContent,
  templateLanguage
) {
  if (!GEMINI_API_KEY) {
    console.warn("GEMINI_API_KEY is not set. Skipping AI content generation.");
    return "";
  }

  const prompt = `
You are an expert in writing Git Pull Request descriptions.
Your task is to generate a clear, concise, and comprehensive Pull Request description.

Here's the process:
1.  **Analyze Commit Messages:** Review the provided Git commit messages.
2.  **Fill Template Sections:** Use the information from the commit messages to fill in the relevant sections of the PR template.
3.  **Prioritize Clarity and Detail:** Ensure the generated content is easy to understand and provides sufficient detail for reviewers.
4.  **Handle Missing Information:** If a section in the template cannot be directly filled by the commit messages, either leave it as is (if it's a placeholder like #ISSUE_NUMBER) or indicate that it's not applicable (e.g., "N/A" or "No relevant changes").
5.  **Maintain Markdown Formatting:** Preserve the markdown structure of the template.
6.  **Generate in the specified language:** The PR description should be generated in the language specified by 'templateLanguage'.

Commit Messages:
${commitMessages.join("\n")}

PR Template (Language: ${templateLanguage}):
${templateContent}

Generated PR Description:
`;

  try {
    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response.text();
  } catch (error) {
    console.error("Error generating AI content:", error.message);
    return "<!-- AI content generation failed. Please fill manually. -->";
  }
}

/**
 * Main function to run the CLI tool.
 * It parses command-line arguments, fetches commit history, categorizes commits,
 * prompts for a PR template and language (if available), generates the PR description
 * (potentially with AI enhancement), and optionally copies it to the clipboard.
 */
async function main() {
  const argv = yargs(hideBin(process.argv))
    .option("copy", {
      alias: "c",
      type: "boolean",
      description:
        "Automatically copy the generated PR description to the clipboard",
    })
    .help().argv;

  console.log("Generating PR description...");

  const commitMessages = await getCommitHistory();
  if (commitMessages.length === 0) {
    console.log("No new commits found since the last push to origin. Exiting.");
    return;
  }

  const categorized = categorizeCommits(commitMessages);

  const templates = await getPRTemplates();
  let templateContent = null;
  if (templates.length > 0) {
    templateContent = await chooseTemplate(templates);
  }

  let templateLanguage = "en";

  if (templateContent) {
    const { selectedLanguage } = await inquirer.default.prompt([
      {
        type: "list",
        name: "selectedLanguage",
        message: "Select the language of the PR template:",
        choices: [
          { name: "English", value: "en" },
          { name: "Portuguese", value: "pt" },
          { name: "Spanish", value: "es" },
          { name: "French", value: "fr" },
          { name: "German", value: "de" },
          { name: "Italian", value: "it" },
          { name: "Japanese", value: "ja" },
          { name: "Chinese", value: "zh" },
        ],
        default: "en",
      },
    ]);
    templateLanguage = selectedLanguage;
  }

  let prDescription;
  if (templateContent) {
    console.log("Generating AI-enhanced PR description with template...");
    const aiGeneratedContent = await generateAIContent(
      commitMessages,
      templateContent,
      templateLanguage
    );
    prDescription = aiGeneratedContent;
  } else {
    prDescription = generatePRDescription(categorized, templateContent);
  }

  console.log("\n--- Generated PR Description ---\n");
  console.log(prDescription);
  console.log("\n--------------------------------\n");

  if (argv.copy) {
    try {
      await clipboardy.write(prDescription);
      console.log("PR description copied to clipboard!");
    } catch (error) {
      console.error("Failed to copy to clipboard:", error.message);
    }
  }
}

main().catch(console.error);
