#!/usr/bin/env node

const { exec } = require('child_process');

// Define the mapping of commit prefixes to their corresponding section titles in the PR description.
const commitTypeMapping = {
  feat: 'Features',
  fix: 'Bug Fixes',
  chore: 'Chores',
  refactor: 'Refactors',
  docs: 'Documentation',
  style: 'Styles',
  test: 'Tests',
  perf: 'Performance Improvements',
  ci: 'Continuous Integration',
  build: 'Builds',
  revert: 'Reverts',
};

/**
 * Executes a shell command and returns its output as a Promise.
 * @param {string} command - The shell command to execute.
 * @returns {Promise<string>} A promise that resolves with the command's stdout.
 */
function executeCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error executing command: ${command}\n${stderr}`);
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/**
 * Generates a PR description from git commits.
 * @param {string[]} commits - An array of commit messages.
 * @returns {string} The formatted PR description.
 */
function generatePRDescription(commits) {
  const categorizedCommits = {};

  // Initialize categories
  Object.values(commitTypeMapping).forEach(category => {
    categorizedCommits[category] = [];
  });

  // Categorize each commit
  commits.forEach(commit => {
    const [type, ...messageParts] = commit.split(':');
    const message = messageParts.join(':').trim();

    if (commitTypeMapping[type]) {
      const category = commitTypeMapping[type];
      categorizedCommits[category].push(message);
    } else {
      // Default category for commits that don't match a prefix
      const defaultCategory = 'Other';
      if (!categorizedCommits[defaultCategory]) {
        categorizedCommits[defaultCategory] = [];
      }
      categorizedCommits[defaultCategory].push(commit);
    }
  });

  // Build the PR description string
  let description = '## Description\n\n';
  Object.entries(categorizedCommits).forEach(([category, messages]) => {
    if (messages.length > 0) {
      description += `### ${category}\n`;
      messages.forEach(msg => {
        description += `- ${msg}\n`;
      });
      description += '\n';
    }
  });

  return description;
}

/**
 * Main function to run the CLI tool.
 */
async function main() {
  // Manually parse for the --copy flag
  const copyToClipboard = process.argv.includes('--copy') || process.argv.includes('-c');

  try {
    // Get commit messages from the current branch compared to 'main'
    const commitsStr = await executeCommand('git log main..HEAD --pretty=format:%s');
    const commits = commitsStr.split('\n').filter(Boolean); // Filter out empty lines

    if (commits.length === 0) {
      console.log('No new commits found since the "main" branch.');
      return;
    }

    // Generate the description
    const prDescription = generatePRDescription(commits);

    // Output the description
    console.log(prDescription);

    // Acknowledge the copy flag
    if (copyToClipboard) {
      // In a real environment, we would use a package like 'clipboardy' here.
      // Since we can't rely on external dependencies, we'll just log a message.
      console.log('\n✅ --copy flag detected. In a functional environment, this would copy the description to your clipboard.');
    }

  } catch (error) {
    console.error('Failed to generate PR description.', error.message);
    process.exit(1);
  }
}

main();
