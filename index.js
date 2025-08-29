#!/usr/bin/env node

import { exec } from "child_process";
import fs from "fs/promises";
import path from "path";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import inquirer from "inquirer";
import clipboardy from "clipboardy";
import { GoogleGenerativeAI } from "@google/generative-ai";

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
 * Gets the Git commit history.
 * If `count` is provided, it fetches the last `count` commits from HEAD.
 * Otherwise, it fetches commits from the current branch's HEAD up to the last push to its upstream.
 * @param {number} [count] The number of commits to retrieve from HEAD.
 * @returns {Promise<string[]>} An array of commit messages. Returns an empty array if no commits are found or an error occurs.
 */
async function getCommitHistory(count) {
  try {
    if (count) {
      const commitLogs = await executeCommand(
        `git log -n ${count} --pretty=format:"%s"`
      );
      return commitLogs.split("\n").filter(Boolean);
    } else {
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
    }
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
  } catch (error) {}
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

  const { selectedTemplatePath } = await inquirer.prompt([
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
 * Parses a GitHub repository URL to extract the owner and repository name.
 * @param {string} repoUrl The full GitHub repository URL (e.g., "https://github.com/owner/repo.git").
 * @returns {{owner: string, repo: string}|null} An object containing owner and repo, or null if parsing fails.
 */
function parseGitHubRepoUrl(repoUrl) {
  const match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/.]+)(\.git)?$/i);
  if (match && match[1] && match[2]) {
    return { owner: match[1], repo: match[2] };
  }
  return null;
}

/**
 * Opens a new GitHub Pull Request page in the browser with the generated description pre-filled.
 * @param {string} prDescription The generated PR description.
 * @param {string} repoUrl The GitHub repository URL.
 * @param {string} currentBranch The current branch name.
 * @param {string} baseBranch The base branch name for the PR.
 */
async function openGitHubPRInBrowser(
  prDescription,
  repoUrl,
  currentBranch,
  baseBranch
) {
  const repoInfo = parseGitHubRepoUrl(repoUrl);
  if (!repoInfo) {
    console.error("Could not parse GitHub repository URL:", repoUrl);
    return;
  }

  const { owner, repo } = repoInfo;
  const prTitle = "feat: Automated PR description";
  const encodedDescription = encodeURIComponent(prDescription);
  const encodedPrTitle = encodeURIComponent(prTitle);

  const githubPRUrl = `https://github.com/${owner}/${repo}/compare/${baseBranch}...${currentBranch}?expand=1&title=${encodedPrTitle}&body=${encodedDescription}`;

  console.log(`\nGenerated GitHub PR URL: ${githubPRUrl}`);
  try {
    await clipboardy.write(githubPRUrl);
    console.log(
      "GitHub PR URL copied to clipboard! Please paste it into your browser."
    );
  } catch (clipboardError) {
    console.error(
      "Failed to copy GitHub PR URL to clipboard:",
      clipboardError.message
    );
  }

  try {
    await clipboardy.write(prDescription);
    console.log(
      "Full PR description copied to clipboard! Paste it into the description field on the GitHub page after opening the URL."
    );
  } catch (clipboardError) {
    console.error(
      "Failed to copy PR description to clipboard:",
      clipboardError.message
    );
  }
}

/**
 * Creates a GitHub Pull Request using the GitHub CLI.
 * @param {string} prDescription The generated PR description.
 * @param {string} currentBranch The current branch name.
 * @param {string} baseBranch The base branch name for the PR.
 */
async function createGitHubPRWithCLI(prDescription, currentBranch, baseBranch) {
  const prTitle = "feat: Automated PR description";

  try {
    await executeCommand("gh --version");
    console.log("GitHub CLI detected.");

    try {
      const existingPr = await executeCommand(
        `gh pr view ${currentBranch} --json url --jq .url`
      );
      if (existingPr) {
        console.log(
          `A pull request for branch "${currentBranch}" already exists: ${existingPr}`
        );
        console.log("Exiting without creating a new PR.");
        return;
      }
    } catch (error) {}

    try {
      await executeCommand(
        `git rev-parse --abbrev-ref --symbolic-full-name @{u}`
      );
    } catch (error) {
      console.log(`Branch "${currentBranch}" is not published to remote.`);
      const { publishBranch } = await inquirer.prompt([
        {
          type: "confirm",
          name: "publishBranch",
          message: `Do you want to publish branch "${currentBranch}" to origin?`,
          default: true,
        },
      ]);

      if (publishBranch) {
        try {
          await executeCommand(
            `git push --set-upstream origin ${currentBranch}`
          );
          console.log(`Branch "${currentBranch}" published successfully.`);
        } catch (publishError) {
          console.error(`Failed to publish branch: ${publishError.message}`);
          return;
        }
      } else {
        console.log("Cannot create PR without publishing the branch. Exiting.");
        return;
      }
    }

    console.log("Creating PR using gh pr create...");

    const tempFilePath = path.join(process.cwd(), "PR_BODY.md");
    await fs.writeFile(tempFilePath, prDescription);

    const ghCommand = `gh pr create --title "${prTitle}" --body-file "${tempFilePath}" --base "${baseBranch}" --head "${currentBranch}"`;
    const ghOutput = await executeCommand(ghCommand);
    console.log("GitHub CLI output:\n", ghOutput);

    await fs.unlink(tempFilePath);

    console.log("Pull Request created successfully via GitHub CLI.");
  } catch (error) {
    console.error("Failed to create PR using GitHub CLI:", error.message);
    console.log(
      "Please ensure GitHub CLI is installed and you are logged in (`gh auth login`)."
    );
  }
}

/**
 * Generates content using Google Gemini based on commit messages and a template.
 * This function constructs a prompt for the AI to generate a PR description by filling
 * the provided template with information extracted from commit messages.
 * @param {string[]} commitMessages An array of raw commit messages.
 * @param {string} templateContent The content of the chosen PR template.
 * @param {string} templateLanguage The language of the PR template (e.g., "en", "pt").
 * @param {string} devDescription The developer's brief description of their work.
 * @returns {Promise<string>} The AI-generated content for the PR description. Returns a fallback comment if AI generation fails.
 */
async function generateAIContent(
  commitMessages,
  templateContent,
  templateLanguage,
  devDescription
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

Developer's Description of Work:
${devDescription || "No additional description provided."}

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
    .option("github", {
      alias: "g",
      type: "boolean",
      description: "Open GitHub PR page with pre-filled description in browser",
    })
    .option("gh", {
      type: "boolean",
      description: "Create GitHub PR using GitHub CLI",
    })
    .help().argv;

  console.log("Generating PR description...");

  let commitMessages = await getCommitHistory();

  if (commitMessages.length === 0) {
    console.log("No new local commits found since the last push to origin.");
    const { commitCount } = await inquirer.prompt([
      {
        type: "number",
        name: "commitCount",
        message:
          "How many remote commits should be read for history? (Enter 0 to exit)",
        default: 5,
        validate: (input) =>
          input >= 0 || "Please enter a non-negative number.",
      },
    ]);

    if (commitCount === 0) {
      console.log("Exiting without generating PR description.");
      return;
    }
    commitMessages = await getCommitHistory(commitCount);
    if (commitMessages.length === 0) {
      console.log("No commits found even from remote. Exiting.");
      return;
    }
  }

  const { devDescription } = await inquirer.prompt([
    {
      type: "input",
      name: "devDescription",
      message: "Please provide a brief description of what you did:",
      default: "",
    },
  ]);

  const categorized = categorizeCommits(commitMessages);

  const templates = await getPRTemplates();
  let templateContent = null;
  if (templates.length > 0) {
    templateContent = await chooseTemplate(templates);
  }

  let templateLanguage = "en";

  if (templateContent) {
    const { selectedLanguage } = await inquirer.prompt([
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
      templateLanguage,
      devDescription
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

  if (argv.github) {
    const repoUrl = await executeCommand("git config --get remote.origin.url");
    const currentBranch = await executeCommand(
      "git rev-parse --abbrev-ref HEAD"
    );
    const baseBranch = "main";
    await openGitHubPRInBrowser(
      prDescription,
      repoUrl,
      currentBranch,
      baseBranch
    );
  } else if (argv.gh) {
    let currentBranch = await executeCommand("git rev-parse --abbrev-ref HEAD");
    const baseBranch = "main";

    if (currentBranch === "main" || currentBranch === "master") {
      const { createNewBranch } = await inquirer.prompt([
        {
          type: "confirm",
          name: "createNewBranch",
          message: `You are on the "${currentBranch}" branch. Do you want to create a new branch for your PR?`,
          default: true,
        },
      ]);

      if (createNewBranch) {
        const defaultNewBranchName = `feat/pr-cli-${Date.now()
          .toString()
          .substring(8)}`;
        const { newBranchName } = await inquirer.prompt([
          {
            type: "input",
            name: "newBranchName",
            message: "Enter the new branch name:",
            default: defaultNewBranchName,
            validate: (input) =>
              input.trim().length > 0 || "Branch name cannot be empty.",
          },
        ]);

        try {
          await executeCommand(`git checkout -b ${newBranchName}`);
          console.log(`Switched to new branch: ${newBranchName}`);
          currentBranch = newBranchName;
        } catch (error) {
          console.error(
            `Failed to create and switch to new branch: ${error.message}`
          );
          return;
        }
      } else {
        console.log("Proceeding with PR creation on the current branch.");
      }
    }
    await createGitHubPRWithCLI(prDescription, currentBranch, baseBranch);
  }
}

main().catch(console.error);
