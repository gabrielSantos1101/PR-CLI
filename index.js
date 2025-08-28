const { program } = require("commander");
const { exec } = require("child_process");
const fs = require("fs").promises;
const path = require("path");
const inquirer = require("inquirer");
const clipboardy = require("clipboardy");

const COMMIT_TYPES = {
  feat: "Features",
  fix: "Bug Fixes",
  chore: "Chores",
  refactor: "Refactors",
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
 * @returns {Promise<string>} The stdout of the command.
 */
async function executeCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error executing command: ${command}`);
        console.error(stderr);
        return reject(error);
      }
      resolve(stdout.trim());
    });
  });
}

/**
 * Retrieves Git commit messages from the current branch up to the last push.
 * @returns {Promise<Array<string>>} An array of commit messages.
 */
async function getCommitHistory() {
  try {
    const currentBranch = await executeCommand(
      "git rev-parse --abbrev-ref HEAD"
    );
    const remoteBranch = await executeCommand(
      `git for-each-ref --format='%(upstream:short)' refs/heads/${currentBranch}`
    );

    let command;
    if (remoteBranch) {
      command = `git log ${remoteBranch}..HEAD --pretty=format:%s`;
    } else {
      console.warn(
        "No remote tracking branch found. Analyzing recent commits on the current branch."
      );
      command = "git log -50 --pretty=format:%s"; // Adjust as needed
    }

    const commitLog = await executeCommand(command);
    return commitLog.split("\n").filter(Boolean); // Filter out empty lines
  } catch (error) {
    console.error(
      "Failed to retrieve Git commit history. Ensure you are in a Git repository."
    );
    throw error;
  }
}

/**
 * Categorizes commit messages based on conventional commit prefixes.
 * @param {Array<string>} commitMessages An array of raw commit messages.
 * @returns {Object<string, Array<string>>} An object where keys are categories and values are arrays of commit messages.
 */
function categorizeCommits(commitMessages) {
  const categorized = {};
  for (const type in COMMIT_TYPES) {
    categorized[COMMIT_TYPES[type]] = [];
  }

  commitMessages.forEach((message) => {
    const match = message.match(/^(\w+)(\(.+\))?: (.+)$/);
    if (match) {
      const type = match[1];
      const description = match[3];
      if (COMMIT_TYPES[type]) {
        categorized[COMMIT_TYPES[type]].push(description);
      } else {
        if (!categorized["Other"]) {
          categorized["Other"] = [];
        }
        categorized["Other"].push(message);
      }
    } else {
      if (!categorized["Other"]) {
        categorized["Other"] = [];
      }
      categorized["Other"].push(message);
    }
  });
  return categorized;
}

/**
 * Generates the PR description based on categorized commits.
 * @param {Object<string, Array<string>>} categorizedCommits Categorized commit messages.
 * @returns {string} The formatted PR description.
 */
function generatePrDescription(categorizedCommits) {
  let description = "";
  for (const category in categorizedCommits) {
    const commits = categorizedCommits[category];
    if (commits.length > 0) {
      description += `### ${category}\n\n`;
      commits.forEach((commit) => {
        description += `- ${commit}\n`;
      });
      description += "\n";
    }
  }
  return description.trim();
}

/**
 * Checks for and lists PR templates in the .github folder.
 * @returns {Promise<Array<{name: string, value: string}>>} An array of template choices.
 */
async function getPrTemplates() {
  const githubPath = path.join(process.cwd(), ".github");
  const templateDir = path.join(githubPath, "PULL_REQUEST_TEMPLATE");
  const templates = [];

  try {
    const templateFiles = await fs.readdir(templateDir);
    for (const file of templateFiles) {
      if (file.endsWith(".md")) {
        templates.push({
          name: file.replace(".md", ""),
          value: path.join(templateDir, file),
        });
      }
    }
  } catch (error) {
    try {
      const githubFiles = await fs.readdir(githubPath);
      for (const file of githubFiles) {
        if (
          file.endsWith(".md") &&
          file.toLowerCase().includes("pull_request_template")
        ) {
          templates.push({
            name: file.replace(".md", ""),
            value: path.join(githubPath, file),
          });
        }
      }
    } catch (err) {}
  }
  return templates;
}

async function run() {
  program
    .option("-c, --copy", "Copy the generated PR description to clipboard")
    .parse(process.argv);

  const options = program.opts();

  try {
    console.log("Analyzing Git commit history...");
    const commitMessages = await getCommitHistory();
    const categorizedCommits = categorizeCommits(commitMessages);
    let prDescription = generatePrDescription(categorizedCommits);

    console.log("Checking for PR templates...");
    const templates = await getPrTemplates();

    let briefDescription = "";
    const descriptionAnswer = await inquirer.prompt([
      {
        type: "input",
        name: "brief",
        message:
          "Please provide a brief description of what you did in this PR:",
      },
    ]);
    briefDescription = descriptionAnswer.brief.trim();

    if (briefDescription) {
      prDescription =
        `## Brief Description\n\n${briefDescription}\n\n` + prDescription;
    }

    if (templates.length > 0) {
      let selectedTemplatePath = null;

      if (templates.length === 1) {
        console.log(
          `Found one template: "${templates[0].name}". Using it by default.`
        );
        selectedTemplatePath = templates[0].value;
      } else {
        const answers = await inquirer.prompt([
          {
            type: "list",
            name: "template",
            message: 'Select a PR template (or choose "None" to skip):',
            choices: [{ name: "None", value: null }, ...templates],
          },
        ]);
        selectedTemplatePath = answers.template;
      }

      if (selectedTemplatePath) {
        console.log(`Reading template from ${selectedTemplatePath}...`);
        const templateContent = await fs.readFile(selectedTemplatePath, "utf8");
        prDescription = templateContent + "\n\n" + prDescription;
      }
    } else {
      console.log(
        "No PR templates found. Generating description based on commits only."
      );
    }

    console.log("\n--- Generated PR Description ---");
    console.log(prDescription);
    console.log("------------------------------\n");

    if (options.copy) {
      await clipboardy.write(prDescription);
      console.log("PR description copied to clipboard!");
    }
  } catch (error) {
    console.error("An error occurred:", error.message);
    process.exit(1);
  }
}

run();
