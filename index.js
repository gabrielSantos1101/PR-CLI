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
const fetch = globalThis.fetch;

if (typeof fetch !== "function") {
  throw new Error("Fetch API requires Node.js 18 or newer.");
}

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
 * Truncates a diff to a maximum size while preserving structure.
 * Keeps file headers and a sample of changes from each file.
 * @param {string} diffContent The diff content to truncate.
 * @param {number} maxSize Maximum size in characters.
 * @returns {{content: string, wasTruncated: boolean}} Truncated diff and truncation flag.
 */
function truncateDiff(diffContent, maxSize = 10000) {
  if (diffContent.length <= maxSize) {
    return { content: diffContent, wasTruncated: false };
  }

  const lines = diffContent.split('\n');
  const result = [];
  let currentSize = 0;
  let filesProcessed = 0;
  let currentFile = null;
  let linesInCurrentFile = 0;
  const maxLinesPerFile = 40;

  for (const line of lines) {
    if (line.startsWith('diff --git') || line.startsWith('index ') || 
        line.startsWith('---') || line.startsWith('+++')) {
      if (line.startsWith('diff --git')) {
        if (currentFile && linesInCurrentFile > maxLinesPerFile) {
          result.push(`... (${linesInCurrentFile - maxLinesPerFile} more lines omitted)`);
        }
        filesProcessed++;
        currentFile = line;
        linesInCurrentFile = 0;
      }
      result.push(line);
      currentSize += line.length + 1;
      continue;
    }

    if (currentSize + line.length > maxSize) {
      result.push(`\n... [Diff truncated: ${diffContent.length - currentSize} characters omitted from ${lines.length - result.length} remaining lines]`);
      return { content: result.join('\n'), wasTruncated: true };
    }

    linesInCurrentFile++;
    if (linesInCurrentFile <= maxLinesPerFile) {
      result.push(line);
      currentSize += line.length + 1;
    }
  }

  if (linesInCurrentFile > maxLinesPerFile) {
    result.push(`... (${linesInCurrentFile - maxLinesPerFile} more lines omitted)`);
  }

  return { content: result.join('\n'), wasTruncated: false };
}

/**
 * Validates if a string is a valid Git commit hash format.
 * Accepts both short (7+ chars) and full (40 chars) SHA-1 hashes.
 * @param {string} hash The commit hash to validate.
 * @returns {boolean} True if the hash format is valid, false otherwise.
 */
function isValidCommitHash(hash) {
  if (typeof hash !== 'string') {
    return false;
  }
  return /^[0-9a-f]{7,40}$/i.test(hash.trim());
}

/**
 * Filters binary file content from git diff output.
 * Detects binary file markers and removes binary data while preserving the markers.
 * @param {string} diffContent The raw diff content from git.
 * @returns {string} The filtered diff content with binary data removed.
 */
function filterBinaryFiles(diffContent) {
  const lines = diffContent.split('\n');
  const filtered = [];
  let skipBinary = false;
  
  for (const line of lines) {
    if (line.startsWith('Binary files')) {
      filtered.push(line);
      skipBinary = true;
      continue;
    }
    
    if (line.startsWith('diff --git')) {
      skipBinary = false;
    }
    
    if (!skipBinary) {
      filtered.push(line);
    }
  }
  
  return filtered.join('\n');
}

/**
 * Formats commit diffs for AI prompt inclusion.
 * Creates markdown-formatted code blocks with commit messages, hashes, and truncation notices.
 * @param {Array<{hash: string, content: string, truncated: boolean}>} diffs Array of diff objects.
 * @param {string[]} commitMessages Array of commit messages corresponding to the diffs.
 * @returns {string} Formatted string with diffs in markdown code blocks.
 */
function formatDiffsForAI(diffs, commitMessages) {
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

/**
 * Checks if a commit is a merge commit by examining its parent count.
 * @param {string} commitHash The commit hash to check.
 * @returns {Promise<boolean>} True if the commit is a merge commit (has 2+ parents), false otherwise.
 */
async function isMergeCommit(commitHash) {
  if (!isValidCommitHash(commitHash)) {
    console.warn(`Invalid commit hash format in isMergeCommit: "${commitHash}"`);
    return false;
  }
  
  try {
    const parents = await executeCommand(
      `git rev-list --parents -n 1 ${commitHash}`,
      "",
      false
    );
    return parents.trim().split(/\s+/).length > 2;
  } catch (error) {
    return false;
  }
}

/**
 * Fetches commit diffs for an array of commit hashes.
 * Automatically optimizes diff sizes to prevent token limit issues.
 * @param {string[]} commitHashes Array of commit SHA hashes.
 * @param {Object} options Configuration object.
 * @param {boolean} [options.includeMergeDiffs=false] Whether to include merge commit diffs.
 * @returns {Promise<Array<{hash: string, content: string, truncated: boolean, error: string|null}>>} Array of DiffResult objects.
 */
async function getCommitDiffs(commitHashes, options = {}) {
  const { includeMergeDiffs = false } = options;
  
  if (!Array.isArray(commitHashes)) {
    console.error("Invalid input: commitHashes must be an array");
    return [];
  }
  
  if (commitHashes.length === 0) {
    console.warn("No commit hashes provided to fetch diffs");
    return [];
  }
  
  const spinner = ora("Fetching commit diffs...").start();
  
  const diffs = [];
  let totalSize = 0;
  let validCount = 0;
  let skippedCount = 0;
  let mergeCommitsExcluded = 0;
  let binaryFilesFiltered = 0;
  let fetchFailures = 0;
  const totalCommits = commitHashes.length;
  
  for (let i = 0; i < commitHashes.length; i++) {
    const hash = commitHashes[i];
    
    spinner.text = `Fetching commit diffs... (${i + 1}/${totalCommits})`;
    
    if (!isValidCommitHash(hash)) {
      const errorMsg = `Invalid commit hash format: "${hash}". Expected hexadecimal string (7-40 characters).`;
      console.warn(`⚠ Skipping invalid commit hash: ${hash}`);
      skippedCount++;
      fetchFailures++;
      diffs.push({
        hash: hash || '[empty]',
        content: "[Invalid commit hash - skipped]",
        truncated: false,
        error: errorMsg
      });
      continue;
    }

    try {
      const isMerge = await isMergeCommit(hash);
      if (isMerge && !includeMergeDiffs) {
        mergeCommitsExcluded++;
        diffs.push({
          hash,
          content: "[Merge commit - diff excluded]",
          truncated: false,
          error: null
        });
        validCount++;
        continue;
      }
      
      const diffCommand = isMerge 
        ? `git show --format="" ${hash}`
        : `git show --format="" --no-color ${hash}`;
      
      let diffContent = await executeCommand(diffCommand, "", false);
      
      const hasBinaryFiles = diffContent.includes('Binary files');
      if (hasBinaryFiles) {
        binaryFilesFiltered++;
      }
      
      diffContent = filterBinaryFiles(diffContent);
      
      let finalContent = diffContent;
      let wasTruncated = false;
      const MAX_DIFF_SIZE = 8000;
      
      if (diffContent.length > MAX_DIFF_SIZE) {
        const result = truncateDiff(diffContent, MAX_DIFF_SIZE);
        finalContent = result.content;
        wasTruncated = result.wasTruncated;
      }
      
      totalSize += finalContent.length;
      validCount++;
      diffs.push({ 
        hash, 
        content: finalContent, 
        truncated: wasTruncated,
        error: null
      });
      
    } catch (error) {
      const errorMsg = `Failed to fetch diff for commit ${hash}: ${error.message}`;
      console.warn(`⚠ ${errorMsg}`);
      skippedCount++;
      fetchFailures++;
      diffs.push({ 
        hash, 
        content: "[Error fetching diff]", 
        truncated: false,
        error: error.message
      });
    }
  }
  
  if (skippedCount > 0) {
    spinner.warn(`Fetched diffs for ${validCount}/${diffs.length} commits (${totalSize} characters). ${skippedCount} commit(s) skipped due to errors.`);
  } else {
    spinner.succeed(`Fetched diffs for ${diffs.length} commits (${totalSize} characters)`);
  }
  
  const warnings = [];
  
  if (mergeCommitsExcluded > 0) {
    warnings.push(`⚠ ${mergeCommitsExcluded} merge commit(s) excluded.`);
  }
  
  if (binaryFilesFiltered > 0) {
    warnings.push(`⚠ Binary files detected in ${binaryFilesFiltered} commit(s) and filtered from diffs.`);
  }
  
  const LARGE_DIFF_THRESHOLD = 50000;
  if (totalSize > LARGE_DIFF_THRESHOLD) {
    warnings.push(`⚠ Large diff detected: Total size is ${totalSize} characters (threshold: ${LARGE_DIFF_THRESHOLD}).`);
    warnings.push(`   This may exceed API token limits. Consider reducing commits or using --read without large files.`);
  }
  
  if (fetchFailures > 0) {
    warnings.push(`⚠ ${fetchFailures} commit(s) failed to fetch. Check warnings above for details.`);
  }
  
  if (warnings.length > 0) {
    console.log('\n--- Edge Case Warnings ---');
    warnings.forEach(warning => console.warn(warning));
    console.log('');
  }
  
  return diffs;
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
 * @param {Object} [options={}] Configuration options.
 * @param {boolean} [options.readDiffs=false] Whether to fetch commit diffs.
 * @param {boolean} [options.includeMergeDiffs=false] Whether to include merge commit diffs.
 * @returns {Promise<string[]|{messages: string[], hashes: string[], count: number}>} 
 *   Returns an array of commit messages when readDiffs is false (backward compatible).
 *   Returns an object with messages, hashes, and count when readDiffs is true.
 *   Returns an empty array or empty object if no commits are found or an error occurs.
 */
async function getCommitHistory(count, options = {}) {
  const { readDiffs = false, includeMergeDiffs = false } = options;
  const spinner = ora("Fetching commit history...").start();
  try {
    let commitLogs;
    let commitHashes = [];

    if (count) {
      commitLogs = await executeCommand(
        `git log -n ${count} --pretty=format:"%s"`,
        "Fetching specific number of commits...",
        false
      );

      if (readDiffs) {
        const hashesOutput = await executeCommand(
          `git log -n ${count} --format=%H`,
          "Fetching commit hashes...",
          false
        );
        commitHashes = hashesOutput.split("\n").filter(Boolean);
      }
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

      if (readDiffs) {
        const hashesOutput = await executeCommand(
          `git log ${lastPushCommit}..HEAD --format=%H`,
          "Fetching commit hashes...",
          false
        );
        commitHashes = hashesOutput.split("\n").filter(Boolean);
      }
    }

    spinner.succeed("Commit history fetched.");
    const messages = commitLogs.split("\n").filter(Boolean);

    if (readDiffs) {
      return {
        messages,
        hashes: commitHashes,
        count: messages.length
      };
    }

    return messages;
  } catch (error) {
    spinner.fail("Failed to get Git commit history.");
    console.error(
      "Failed to get Git commit history. Ensure you are in a Git repository and have pushed to origin."
    );
    return readDiffs ? { messages: [], hashes: [], count: 0 } : [];
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
 * Fetches the current PR description from an existing PR using GitHub CLI.
 * @param {string} branchName The branch name to check for existing PR.
 * @returns {Promise<string|null>} The current PR body or null if no PR exists.
 */
async function getExistingPRDescription(branchName) {
  try {
    const prBody = await executeCommand(
      `gh pr view ${branchName} --json body --jq .body`,
      `Fetching existing PR description for branch "${branchName}"...`,
      false
    );
    return prBody || null;
  } catch (error) {
    return null;
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

        let overwritePr = true;

        if (!argv.refill) {
          const promptResult = await inquirer.default.prompt([
            {
              type: "confirm",
              name: "overwritePr",
              message:
                "A PR for this branch already exists. Do you want to overwrite its description with the newly generated content?",
              default: true,
            },
          ]);
          overwritePr = promptResult.overwritePr;
        } else {
          console.log(
            "--refill flag detected; overwriting existing PR description without confirmation."
          );
        }

        if (!overwritePr) {
          console.log("Keeping the current PR description. Exiting.");
          return;
        }

        const tempFilePath = path.join(process.cwd(), "PR_BODY.md");
        await fs.writeFile(tempFilePath, prDescription);

        const editCmd = `gh pr edit ${currentBranch} --body-file "${tempFilePath}"`;
        const ghEditOutput = await executeCommand(
          editCmd,
          "Updating PR description..."
        );
        console.log("GitHub CLI output:\n", ghEditOutput);

        await fs.unlink(tempFilePath);
        console.log("Pull Request description updated successfully.");
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
 * Fetches the current PR description from an existing PR using GitHub CLI.
 * @param {string} branchName The branch name to check for existing PR.
 * @returns {Promise<string|null>} The current PR body or null if no PR exists.
 */
async function getExistingPRDescription(branchName) {
  try {
    const prBody = await executeCommand(
      `gh pr view ${branchName} --json body --jq .body`,
      `Fetching existing PR description for branch "${branchName}"...`,
      false
    );
    return prBody || null;
  } catch (error) {
    return null;
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
 * @param {Array<{hash: string, content: string, truncated: boolean}>|null} commitDiffs Optional array of commit diffs.
 * @param {string|null} existingPRDescription Optional existing PR description to use as context for updates.
 * @returns {Promise<string>} The AI-generated content for the PR description. Returns a fallback comment if AI generation fails.
 */
async function generateAIContent(
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
      .option("read", {
        alias: "r",
        type: "boolean",
        description: "Include commit diffs for more detailed PR descriptions",
      })
      .option("refill", {
        type: "boolean",
        description:
          "When a PR already exists for the branch, overwrite its description without asking for confirmation",
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

    const readOptions = {
      readDiffs: argv.read || false,
      includeMergeDiffs: false
    };
    
    let commitHistoryResult = await getCommitHistory(undefined, readOptions);
    
    let commitMessages = Array.isArray(commitHistoryResult) 
      ? commitHistoryResult 
      : commitHistoryResult.messages;
    let commitHashes = Array.isArray(commitHistoryResult) 
      ? [] 
      : commitHistoryResult.hashes;

    if (commitMessages.length === 0) {
      console.log("No new local commits found since the last push to origin.");
      try {
        const currentBranch = await executeCommand(
          "git rev-parse --abbrev-ref HEAD",
          "Getting current branch...",
          false
        );

        let baseBranch = "main";
        try {
          const remoteHead = await executeCommand(
            "git symbolic-ref refs/remotes/origin/HEAD",
            "Getting remote default branch...",
            false
          );
          baseBranch = remoteHead.split("/").pop();
        } catch (e) {
          console.warn(
            "Could not determine remote default branch, falling back to 'main'."
          );
        }

        const commitCountStr = await executeCommand(
          `git rev-list --count ${baseBranch}..HEAD`,
          `Counting commits on branch "${currentBranch}" against "${baseBranch}"...`,
          false
        );
        const commitCount = parseInt(commitCountStr, 10);

        if (commitCount > 0) {
          if (argv.refill) {
            commitHistoryResult = await getCommitHistory(commitCount, readOptions);
            commitMessages = Array.isArray(commitHistoryResult) 
              ? commitHistoryResult 
              : commitHistoryResult.messages;
            commitHashes = Array.isArray(commitHistoryResult) 
              ? [] 
              : commitHistoryResult.hashes;
          } else {
            const { confirmCommits } = await inquirer.default.prompt([
              {
                type: "confirm",
                name: "confirmCommits",
                message: `Found ${commitCount} commits on branch "${currentBranch}". Do you want to use them to create the PR?`,
                default: true,
              },
            ]);

            if (confirmCommits) {
              commitHistoryResult = await getCommitHistory(commitCount, readOptions);
              commitMessages = Array.isArray(commitHistoryResult) 
                ? commitHistoryResult 
                : commitHistoryResult.messages;
              commitHashes = Array.isArray(commitHistoryResult) 
                ? [] 
                : commitHistoryResult.hashes;
            } else {
              console.log("Exiting without generating PR description.");
              return;
            }
          }
        } else {
          console.log(
            `No commits found on this branch compared to ${baseBranch}. Exiting.`
          );
          return;
        }
      } catch (error) {
        console.log(
          "Could not automatically count commits. Falling back to manual input."
        );
        const { commitCount } = await inquirer.default.prompt([
          {
            type: "number",
            name: "commitCount",
            message:
              "How many commits from HEAD should be read for history? (Enter 0 to exit)",
            default: 5,
            validate: (input) =>
              input >= 0 || "Please enter a non-negative number.",
          },
        ]);

        if (commitCount === 0) {
          console.log("Exiting without generating PR description.");
          return;
        }
        commitHistoryResult = await getCommitHistory(commitCount, readOptions);
        commitMessages = Array.isArray(commitHistoryResult) 
          ? commitHistoryResult 
          : commitHistoryResult.messages;
        commitHashes = Array.isArray(commitHistoryResult) 
          ? [] 
          : commitHistoryResult.hashes;
      }

      if (commitMessages.length === 0) {
        console.log("No commits found. Exiting.");
        return;
      }
    }

    let commitDiffs = null;
    if (argv.read && commitHashes.length > 0) {
      try {
        commitDiffs = await getCommitDiffs(commitHashes, {
          includeMergeDiffs: false
        });
      } catch (error) {
        console.warn("Failed to fetch commit diffs:", error.message);
        console.log("Continuing with commit messages only.");
        commitDiffs = null;
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

    let existingPRDescription = null;
    if (argv.read) {
      try {
        const currentBranch = await executeCommand(
          "git rev-parse --abbrev-ref HEAD",
          "Getting current branch...",
          false
        );
        existingPRDescription = await getExistingPRDescription(currentBranch);
        if (existingPRDescription) {
          console.log("✓ Found existing PR description. Will use it as context for updates.");
        }
      } catch (error) {}
    }

    let prDescription;
    if (templateContent) {
      const aiGeneratedContent = await generateAIContent(
        commitMessages,
        templateContent,
        templateLanguage,
        devDescription,
        commitDiffs,
        existingPRDescription
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
