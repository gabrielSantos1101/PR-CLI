#!/usr/bin/env node

const { exec } = require("child_process");
const fs = require("fs").promises;
const path = require("path");
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");
const inquirer = require("inquirer");
const { ExitPromptError } = require("@inquirer/core");
const clipboardy = require("clipboardy");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const ora = require("ora").default;
const os = require("os");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

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
async function executeCommand(
  command,
  spinnerText = "Executing command...",
  logSuccess = true
) {
  const spinner = ora(spinnerText).start();
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        spinner.fail(`Command failed: ${command}`);
        console.error(`exec error: ${error}`);
        return reject(error);
      }
      if (stderr) {
        spinner.warn(`Command had stderr: ${stderr}`);
        console.error(`stderr: ${stderr}`);
      } else if (logSuccess) {
        spinner.succeed(`Command successful: ${command}`);
      } else {
        spinner.stop();
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
/**
 * Gets the Git commit history.
 * If `count` is provided, it fetches the last `count` commits from HEAD.
 * Otherwise, it fetches commits from the current branch's HEAD up to the last push to its upstream.
 * @param {number} [count] The number of commits to retrieve from HEAD.
 * @returns {Promise<string[]>} An array of commit messages. Returns an empty array if no commits are found or an error occurs.
 */
async function getCommitHistory(count) {
  const spinner = ora("Fetching commit history...").start();
  try {
    let commitLogs;
    if (count) {
      commitLogs = await executeCommand(
        `git log -n ${count} --pretty=format:"%s"`,
        "Fetching specific number of commits...",
        false
      );
    } else {
      const currentBranch = await executeCommand(
        "git rev-parse --abbrev-ref HEAD",
        "Getting current branch...",
        false
      );
      const lastPushCommit = await executeCommand(
        `git merge-base ${currentBranch} origin/${currentBranch}`,
        "Getting last push commit...",
        false
      );
      commitLogs = await executeCommand(
        `git log ${lastPushCommit}..HEAD --pretty=format:"%s"`,
        "Fetching commits since last push...",
        false
      );
    }
    spinner.succeed("Commit history fetched.");
    return commitLogs.split("\n").filter(Boolean);
  } catch (error) {
    spinner.fail("Failed to get Git commit history.");
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
/**
 * Opens a new GitHub Pull Request page in the browser with the generated description pre-filled.
 * Or creates a PR using GitHub CLI if available.
 * @param {string} prDescription The generated PR description.
 * @param {string} repoUrl The GitHub repository URL.
 * @param {string} currentBranch The current branch name.
 * @param {string} baseBranch The base branch name for the PR.
 */
/**
 * Opens a new GitHub Pull Request page in the browser with the generated description pre-filled.
 * @param {string} prDescription The generated PR description.
 * @param {string} repoUrl The GitHub repository URL.
 * @param {string} currentBranch The current branch name.
 * @param {string} baseBranch The base branch name for the PR.
 */
async function openGitHubPRInBrowser(
  prDescription,
  prTitle,
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
  const encodedDescription = encodeURIComponent(prDescription);
  const encodedPrTitle = encodeURIComponent(prTitle);

  const githubPRUrl = `https://github.com/${owner}/${repo}/compare/${baseBranch}...${currentBranch}?expand=1&title=${encodedPrTitle}&body=${encodedDescription}`;

  console.log(`\nGenerated GitHub PR URL: ${githubPRUrl}`);
  try {
    await clipboardy.default.write(githubPRUrl);
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
    await clipboardy.default.write(prDescription);
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
 * @param {string} prTitle The generated PR title.
 * @param {string} currentBranch The current branch name.
 * @param {string} baseBranch The base branch name for the PR.
 */
async function createGitHubPRWithCLI(
  prDescription,
  prTitle,
  currentBranch,
  baseBranch,
  argv
) {
  try {
    await executeCommand("gh --version", "Checking for GitHub CLI...");
    console.log("GitHub CLI detected.");

    try {
      const existingPr = await executeCommand(
        `gh pr view ${currentBranch} --json url --jq .url`,
        `Checking for existing PR for branch "${currentBranch}"...`,
        false
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
        `git rev-parse --abbrev-ref --symbolic-full-name @{u}`,
        `Checking if branch "${currentBranch}" is published...`,
        false
      );
    } catch (error) {
      console.log(`Branch "${currentBranch}" is not published to remote.`);
      const { publishBranch } = await inquirer.default.prompt([
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
            `git push --set-upstream origin ${currentBranch}`,
            `Publishing branch "${currentBranch}"...`
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

    let ghCommand = `gh pr create --title "${prTitle}" --body-file "${tempFilePath}" --base "${baseBranch}" --head "${currentBranch}"`;

    if (argv.self) {
      ghCommand += ' --assignee "@me"';
    }

    if (argv.draft) {
      ghCommand += " --draft";
    }
    const ghOutput = await executeCommand(ghCommand, "Creating GitHub PR...");
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
 * Generates a suggested branch type (e.g., "feat", "fix") using Google Gemini based on commit messages.
 * @param {string[]} commitMessages An array of raw commit messages.
 * @returns {Promise<string>} The AI-generated branch type. Returns a fallback ("feat") if AI generation fails.
 */
async function generateAIBranchType(commitMessages) {
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
 * Generates a full branch name (type/description-kebab-case) using Google Gemini based on commit messages.
 * @param {string[]} commitMessages An array of raw commit messages.
 * @returns {Promise<string>} The AI-generated full branch name. Returns a fallback if AI generation fails.
 */
async function generateAIBranchName(commitMessages) {
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

  const spinner = ora("Generating AI-enhanced PR description...").start();
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
    console.warn("Returning original template due to AI generation failure.");
    return `<!-- Error: AI content generation failed. Please review and fill manually. Details: ${error.message} -->\n\n${templateContent}`;
  }
}

/**
 * Main function to run the CLI tool.
 * It parses command-line arguments, fetches commit history, categorizes commits,
 * prompts for a PR template and language (if available), generates the PR description
 * (potentially with AI enhancement), and optionally copies it to the clipboard.
 */
const PACKAGE_VERSION = require("./package.json").version;
const PACKAGE_NAME = require("./package.json").name;
const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000;

/**
 * Gets the path to the update timestamp file.
 * @returns {string} The full path to the timestamp file.
 */
function getUpdateTimestampFilePath() {
  const homeDir = os.homedir();
  const cliConfigDir = path.join(homeDir, ".pr-cli");
  return path.join(cliConfigDir, "last_update_check.txt");
}

/**
 * Compares two semantic version strings.
 * @param {string} v1 Version string 1.
 * @param {string} v2 Version string 2.
 * @returns {boolean} True if v1 is older than v2, false otherwise.
 */
function isVersionOlder(v1, v2) {
  const parts1 = v1.split(".").map(Number);
  const parts2 = v2.split(".").map(Number);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;

    if (p1 < p2) {
      return true;
    }
    if (p1 > p2) {
      return false;
    }
  }
  return false;
}

async function checkForUpdates() {
  const spinner = ora("Checking for updates...").start();
  const timestampFilePath = getUpdateTimestampFilePath();

  try {
    const lastCheckTime = await fs
      .readFile(timestampFilePath, "utf-8")
      .then(Number)
      .catch(() => 0);
    const currentTime = Date.now();

    if (currentTime - lastCheckTime < UPDATE_CHECK_INTERVAL) {
      spinner.succeed();
      return false;
    }

    const response = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}`);
    if (!response.ok) {
      spinner.fail(`Failed to fetch package info: ${response.statusText}`);
      throw new Error(`Failed to fetch package info: ${response.statusText}`);
    }
    const data = await response.json();
    const latestVersion = data["dist-tags"].latest;

    if (isVersionOlder(PACKAGE_VERSION, latestVersion)) {
      spinner.warn(`A new version of ${PACKAGE_NAME} is available!`);
      console.warn(`   Current version: ${PACKAGE_VERSION}`);
      console.warn(`   Latest version:  ${latestVersion}`);
      await fs
        .mkdir(path.dirname(timestampFilePath), { recursive: true })
        .catch(() => {});
      await fs.writeFile(timestampFilePath, currentTime.toString());
      return true;
    }
    spinner.succeed("No updates available.");
    await fs
      .mkdir(path.dirname(timestampFilePath), { recursive: true })
      .catch(() => {});
    await fs.writeFile(timestampFilePath, currentTime.toString());
    return false;
  } catch (error) {
    spinner.fail("Error checking for updates.");
    console.error("Error checking for updates:", error.message);
    return false;
  }
}

async function main() {
  try {
    const updateAvailable = await checkForUpdates();

    if (updateAvailable) {
      const { confirmUpdate } = await inquirer.default.prompt([
        {
          type: "confirm",
          name: "confirmUpdate",
          message: `Do you want to update ${PACKAGE_NAME} to the latest version? (This will run 'npm i -g ${PACKAGE_NAME}')`,
          default: true,
        },
      ]);

      if (confirmUpdate) {
        const updateSpinner = ora(`Updating ${PACKAGE_NAME}...`).start();
        try {
          await executeCommand(
            `npm i -g ${PACKAGE_NAME}`,
            "Installing update..."
          );
          updateSpinner.succeed(
            `${PACKAGE_NAME} updated successfully! Please restart the CLI.`
          );
          process.exit(0);
        } catch (error) {
          console.error(`Failed to update ${PACKAGE_NAME}:`, error.message);
          console.log(
            "Please try updating manually: npm i -g pr-cli-generator"
          );
        }
      } else {
        console.log("Update skipped. Continuing with current version.");
      }
    }

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
        description:
          "Open GitHub PR page with pre-filled description in browser",
      })
      .option("gh", {
        type: "boolean",
        description: "Create GitHub PR using GitHub CLI",
      })
      .option("self", {
        type: "boolean",
        description: "Assign the PR to yourself",
      })
      .option("draft", {
        type: "boolean",
        description: "Create the PR as a draft",
      })
      .help().argv;

    let commitMessages = await getCommitHistory();

    if (commitMessages.length === 0) {
      console.log("No new local commits found since the last push to origin.");
      const { commitCount } = await inquirer.default.prompt([
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

    const { devDescription } = await inquirer.default.prompt([
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
      const aiGeneratedContent = await generateAIContent(
        commitMessages,
        templateContent,
        templateLanguage,
        devDescription
      );
      prDescription = aiGeneratedContent;
      if (
        prDescription.startsWith("<!-- Error: AI content generation failed.")
      ) {
        console.warn(
          "AI generation failed, falling back to categorized commit description."
        );
        prDescription = generatePRDescription(categorized, templateContent);
      }
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

    let prTitle;

    if (argv.github) {
      const repoUrl = await executeCommand(
        "git config --get remote.origin.url",
        "Getting repository URL...",
        false
      );
      const currentBranch = await executeCommand(
        "git rev-parse --abbrev-ref HEAD",
        "Getting current branch...",
        false
      );
      const baseBranch = "main";
      prTitle = currentBranch;
      await openGitHubPRInBrowser(
        prDescription,
        prTitle,
        repoUrl,
        currentBranch,
        baseBranch
      );
    } else if (argv.gh) {
      let currentBranch = await executeCommand(
        "git rev-parse --abbrev-ref HEAD",
        "Getting current branch...",
        false
      );
      const baseBranch = "main";

      if (currentBranch === "main" || currentBranch === "master") {
        const { createNewBranch } = await inquirer.default.prompt([
          {
            type: "confirm",
            name: "createNewBranch",
            message: `You are on the "${currentBranch}" branch. Do you want to create a new branch for your PR?`,
            default: true,
          },
        ]);

        if (createNewBranch) {
          const { generateWithAI } = await inquirer.default.prompt([
            {
              type: "confirm",
              name: "generateWithAI",
              message: "Do you want to generate the branch name using AI?",
              default: true,
            },
          ]);

          let newBranchName;
          if (generateWithAI) {
            newBranchName = await generateAIBranchName(commitMessages);
            if (!newBranchName) {
              console.warn(
                "AI failed to generate a branch name. Falling back to manual input with AI-suggested type."
              );
              const suggestedType = await generateAIBranchType(commitMessages);
              const { manualDescription } = await inquirer.default.prompt([
                {
                  type: "input",
                  name: "manualDescription",
                  message: `Enter a short description for the new branch (e.g., 'add user auth', spaces will be converted to hyphens). Suggested type: ${suggestedType}/`,
                  validate: (input) =>
                    input.trim().length > 0 ||
                    "Branch description cannot be empty.",
                  filter: (input) =>
                    input
                      .toLowerCase()
                      .replace(/\s+/g, "-")
                      .replace(/[^a-z0-9-]/g, ""),
                },
              ]);
              newBranchName = `${suggestedType}/${manualDescription}`;
            } else {
              console.log(`AI suggested branch name: ${newBranchName}`);
              const { confirmAIBranchName } = await inquirer.default.prompt([
                {
                  type: "confirm",
                  name: "confirmAIBranchName",
                  message: `Confirm AI-generated branch name: "${newBranchName}"?`,
                  default: true,
                },
              ]);
              if (!confirmAIBranchName) {
                const suggestedType = await generateAIBranchType(
                  commitMessages
                );
                const { manualDescription } = await inquirer.default.prompt([
                  {
                    type: "input",
                    name: "manualDescription",
                    message: `Enter a short description for the new branch (e.g., 'add user auth', spaces will be converted to hyphens). Suggested type: ${suggestedType}/`,
                    validate: (input) =>
                      input.trim().length > 0 ||
                      "Branch description cannot be empty.",
                    filter: (input) =>
                      input
                        .toLowerCase()
                        .replace(/\s+/g, "-")
                        .replace(/[^a-z0-9-]/g, ""),
                  },
                ]);
                newBranchName = `${suggestedType}/${manualDescription}`;
              }
            }
          } else {
            console.log(
              "Skipping AI branch name generation. Suggesting type based on commits."
            );
            const suggestedType = await generateAIBranchType(commitMessages);
            const { manualDescription } = await inquirer.default.prompt([
              {
                type: "input",
                name: "manualDescription",
                message: `Enter a short description for the new branch (e.g., 'add user auth', spaces will be converted to hyphens). Suggested type: ${suggestedType}/`,
                validate: (input) =>
                  input.trim().length > 0 ||
                  "Branch description cannot be empty.",
                filter: (input) =>
                  input
                    .toLowerCase()
                    .replace(/\s+/g, "-")
                    .replace(/[^a-z0-9-]/g, ""),
              },
            ]);
            newBranchName = `${suggestedType}/${manualDescription}`;
          }

          try {
            await executeCommand(`git checkout -b ${newBranchName}`);
            console.log(`Switched to new branch: ${newBranchName}`);
            currentBranch = newBranchName;
            prTitle = newBranchName;
          } catch (error) {
            console.error(
              `Failed to create and switch to new branch: ${error.message}`
            );
            return;
          }
        } else {
          console.log("Proceeding with PR creation on the current branch.");
          prTitle = currentBranch;
        }
      } else {
        prTitle = currentBranch;
      }
      await createGitHubPRWithCLI(
        prDescription,
        prTitle,
        currentBranch,
        baseBranch,
        argv
      );
    }
  } catch (error) {
    if (error instanceof ExitPromptError) {
      console.log("Operation cancelled");
      process.exit(0);
    }
    throw error;
  }
}

main().catch(console.error);
