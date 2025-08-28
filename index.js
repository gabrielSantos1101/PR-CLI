#!/usr/bin/env node

const { exec } = require("child_process");
const fs = require("fs").promises;
const path = require("path");
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");
const inquirer = require("inquirer");
const clipboardy = require("clipboardy");

// Define commit type mappings for PR sections
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
 * @returns {Promise<string[]>} An array of commit messages.
 */
async function getCommitHistory() {
  try {
    // Get the current branch name
    const currentBranch = await executeCommand(
      "git rev-parse --abbrev-ref HEAD"
    );
    // Get the last pushed commit hash for the current branch
    const lastPushCommit = await executeCommand(
      `git merge-base ${currentBranch} origin/${currentBranch}`
    );
    // Get commit messages since the last push
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
 * Categorizes commit messages based on conventional commit prefixes.
 * @param {string[]} commitMessages An array of raw commit messages.
 * @returns {Object.<string, string[]>} An object where keys are PR sections and values are arrays of commit messages.
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
        // If no specific section, add to a general "Other Changes" or similar
        if (!categorized["Other Changes"]) {
          categorized["Other Changes"] = [];
        }
        categorized["Other Changes"].push(`- ${message}`);
      }
    } else {
      // Commits that don't follow conventional format
      if (!categorized["Other Changes"]) {
        categorized["Other Changes"] = [];
      }
      categorized["Other Changes"].push(`- ${message}`);
    }
  }
  return categorized;
}

/**
 * Checks for PR templates in the .github folder and its PULL_REQUEST_TEMPLATE subdirectory.
 * @returns {Promise<string[]>} An array of template file paths.
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

    // Check .github/ directly if no subdirectory or if subdirectory is empty
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
    // console.warn(`Could not read .github folder for templates: ${error.message}`);
    // Ignore error if .github folder doesn't exist
  }
  return templates;
}

/**
 * Prompts the user to choose a PR template.
 * @param {string[]} templates An array of template file paths.
 * @returns {Promise<string|null>} The content of the chosen template, or null if none chosen.
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

  const prDescription = generatePRDescription(categorized, templateContent);

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
