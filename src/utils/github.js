import fs from "fs/promises";
import path from "path";
import inquirer from "inquirer";
import clipboardy from "clipboardy";
import { executeCommand } from "./helpers.js";

/**
 * Parses a GitHub repository URL to extract the owner and repository name.
 * @param {string} repoUrl The full GitHub repository URL.
 * @returns {{owner: string, repo: string}|null}
 */
export function parseGitHubRepoUrl(repoUrl) {
  const match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/.]+)(\.git)?$/i);
  if (match && match[1] && match[2]) {
    return { owner: match[1], repo: match[2] };
  }
  return null;
}

/**
 * Opens a new GitHub Pull Request page in the browser.
 * @param {string} prDescription The generated PR description.
 * @param {string} prTitle The PR title.
 * @param {string} repoUrl The GitHub repository URL.
 * @param {string} currentBranch The current branch name.
 * @param {string} baseBranch The base branch name for the PR.
 */
export async function openGitHubPRInBrowser(
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
 * @param {string} prTitle The generated PR title.
 * @param {string} currentBranch The current branch name.
 * @param {string} baseBranch The base branch name for the PR.
 * @param {Object} argv Command line arguments.
 */
export async function createGitHubPRWithCLI(
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
          const promptResult = await inquirer.prompt([
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
        try {
          const ghEditOutput = await executeCommand(
            editCmd,
            "Updating PR description..."
          );
          console.log("GitHub CLI output:\n", ghEditOutput);

          await fs.unlink(tempFilePath);
          console.log("Pull Request description updated successfully.");
          return;
        } catch (editError) {
          console.error("Failed to update PR description:", editError.message);
          
          if (editError.message.includes("Projects (classic) is being deprecated")) {
            console.log("\n⚠️  GitHub API Error: Projects (classic) is being deprecated.");
            console.log("This is a GitHub API issue. You may need to:");
            console.log("1. Update the PR description manually in the GitHub web interface");
            console.log("2. Or try updating GitHub CLI to the latest version");
            console.log("3. Or contact GitHub support if the issue persists");
          } else {
            console.log("The PR exists but we couldn't update it. You may need to update it manually.");
          }
          
          console.log(`PR URL: ${existingPr}`);
          
          try {
            await fs.unlink(tempFilePath);
          } catch (unlinkError) {}
          return;
        }
      }
    } catch (error) {
      console.warn(`Could not check for existing PR: ${error.message}`);
      
      if (error.message.includes("Projects (classic) is being deprecated")) {
        console.log("\n⚠️  GitHub API Error: Projects (classic) is being deprecated.");
        console.log("This may prevent checking for existing PRs. The tool will try to create a new PR,");
        console.log("but if a PR already exists, it will fail. You may need to:");
        console.log("1. Check manually if a PR exists for this branch");
        console.log("2. Update GitHub CLI to the latest version");
        console.log("3. Or contact GitHub support if the issue persists");
      }
      
      console.log("Will attempt to create a new PR...");
    }

    try {
      await executeCommand(
        `git rev-parse --abbrev-ref --symbolic-full-name @{u}`,
        `Checking if branch "${currentBranch}" is published...`,
        false
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
