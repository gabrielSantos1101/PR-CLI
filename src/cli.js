#!/usr/bin/env node

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import inquirer from "inquirer";
import { ExitPromptError } from "@inquirer/core";
import clipboardy from "clipboardy";

import { checkForUpdates, handleUpdate } from "./services/update.js";
import { categorizeCommits } from "./services/commit.js";
import {
  getPRTemplates,
  chooseTemplate,
  generatePRDescription,
  getExistingPRDescription,
} from "./services/pr.js";

import { executeCommand } from "./utils/helpers.js";
import { getCommitHistory, getCommitDiffs } from "./utils/git.js";
import {
  generateAIBranchType,
  generateAIBranchName,
  generateAIContent,
} from "./utils/ai.js";
import {
  openGitHubPRInBrowser,
  createGitHubPRWithCLI,
} from "./utils/github.js";

/**
 * Main function to run the CLI tool.
 */
async function main() {
  try {
    const updateAvailable = await checkForUpdates();
    await handleUpdate(updateAvailable);

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
            const { confirmCommits } = await inquirer.prompt([
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
        const { commitCount } = await inquirer.prompt([
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
        const { createNewBranch } = await inquirer.prompt([
          {
            type: "confirm",
            name: "createNewBranch",
            message: `You are on the "${currentBranch}" branch. Do you want to create a new branch for your PR?`,
            default: true,
          },
        ]);

        if (createNewBranch) {
          const { generateWithAI } = await inquirer.prompt([
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
              const { manualDescription } = await inquirer.prompt([
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
              const { confirmAIBranchName } = await inquirer.prompt([
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
                const { manualDescription } = await inquirer.prompt([
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
            const { manualDescription } = await inquirer.prompt([
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
