import { ExitPromptError } from "@inquirer/core";
import clipboardy from "clipboardy";
import inquirer from "inquirer";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { categorizeCommits } from "./services/commit.js";
import {
	chooseTemplate,
	generatePRDescription,
	getExistingPRDescription,
	getPRTemplates,
} from "./services/pr.js";
import { checkForUpdates, handleUpdate } from "./services/update.js";
import {
	generateAIBranchName,
	generateAIBranchType,
	generateAIContent,
} from "./utils/ai.js";
import { setDebug, debug } from "./utils/debug.js";
import { getCommitHistory, getCommitDiffs } from "./utils/git.js";
import {
	createGitHubPRWithCLI,
	openGitHubPRInBrowser,
} from "./utils/github.js";
import { executeCommand } from "./utils/helpers.js";

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
			.option("self", {
				type: "boolean",
				description: "Assign the PR to yourself",
			})
			.option("draft", {
				type: "boolean",
				description: "Create the PR as a draft",
			})
			.option("debug", {
				type: "boolean",
				description: "Enable verbose debug logging to help diagnose errors",
			})
			.help().argv;

		setDebug(argv.debug);
		debug("argv:", JSON.stringify(argv, null, 2));

		const readOptions = {
			readDiffs: argv.read || false,
			includeMergeDiffs: false,
		};

		let commitHistoryResult = await getCommitHistory(undefined, readOptions);

		let commitMessages = Array.isArray(commitHistoryResult)
			? commitHistoryResult
			: commitHistoryResult.messages;
		let commitHashes = Array.isArray(commitHistoryResult)
			? []
			: commitHistoryResult.hashes;

		debug(`commitMessages count: ${commitMessages.length}`);
		debug(`commitHashes count: ${commitHashes.length}`);

		if (commitMessages.length === 0) {
			console.log("No new local commits found since the last push to origin.");
			try {
				const currentBranch = await executeCommand(
					"git rev-parse --abbrev-ref HEAD",
					"Getting current branch...",
					false,
				);
				debug(`currentBranch: ${currentBranch}`);

				let baseBranch = "main";
				try {
					const remoteHead = await executeCommand(
						"git symbolic-ref refs/remotes/origin/HEAD",
						"Getting remote default branch...",
						false,
					);
					baseBranch = remoteHead.split("/").pop();
					debug(`remoteHead resolved to baseBranch: ${baseBranch}`);
				} catch (e) {
					debug(`Failed to get remote HEAD: ${e.message}`);
					console.warn(
						"Could not determine remote default branch, falling back to 'main'.",
					);
				}

				const commitCountStr = await executeCommand(
					`git rev-list --count ${baseBranch}..HEAD`,
					`Counting commits on branch "${currentBranch}" against "${baseBranch}"...`,
					false,
				);
				const commitCount = parseInt(commitCountStr, 10);
				debug(`commitCount on branch vs ${baseBranch}: ${commitCount}`);

				if (commitCount > 0) {
					const { confirmCommits } = await inquirer.prompt([
						{
							type: "confirm",
							name: "confirmCommits",
							message: `Found ${commitCount} commits on branch "${currentBranch}". Do you want to use them to create the PR?`,
							default: true,
						},
					]);

					if (confirmCommits) {
						commitHistoryResult = await getCommitHistory(
							commitCount,
							readOptions,
						);
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
				} else {
					console.log(
						`No commits found on this branch compared to ${baseBranch}. Exiting.`,
					);
					return;
				}
			} catch (error) {
				debug(`Error in commit count flow: ${error.message}\n${error.stack}`);
				console.log(
					"Could not automatically count commits. Falling back to manual input.",
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

		debug(`Final commitMessages: ${JSON.stringify(commitMessages)}`);

		let commitDiffs = null;
		if (argv.read && commitHashes.length > 0) {
			debug(
				`Fetching diffs for ${commitHashes.length} commits: ${commitHashes.join(", ")}`,
			);
			try {
				commitDiffs = await getCommitDiffs(commitHashes, {
					includeMergeDiffs: false,
				});
				debug(`Fetched ${commitDiffs.length} diffs`);
			} catch (error) {
				debug(`getCommitDiffs error: ${error.message}\n${error.stack}`);
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
					false,
				);
				debug(
					`Looking for existing PR description for branch: ${currentBranch}`,
				);
				existingPRDescription = await getExistingPRDescription(currentBranch);
				if (existingPRDescription) {
					console.log(
						"✓ Found existing PR description. Will use it as context for updates.",
					);
					debug(
						`Existing PR description length: ${existingPRDescription.length} chars`,
					);
				} else {
					debug("No existing PR description found.");
				}
			} catch (error) {
				debug(`Error fetching existing PR description: ${error.message}`);
			}
		}

		let prDescription;
		if (templateContent) {
			debug(
				`Using template (${templateContent.length} chars), language: ${templateLanguage}, mode: ${existingPRDescription ? "UPDATE" : "CREATE"}`,
			);
			const aiGeneratedContent = await generateAIContent(
				commitMessages,
				templateContent,
				templateLanguage,
				devDescription,
				commitDiffs,
				existingPRDescription,
			);
			prDescription = aiGeneratedContent;
			if (
				prDescription.startsWith("<!-- Error: AI content generation failed.")
			) {
				console.warn(
					"AI generation failed, falling back to categorized commit description.",
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
				false,
			);
			const currentBranch = await executeCommand(
				"git rev-parse --abbrev-ref HEAD",
				"Getting current branch...",
				false,
			);
			const baseBranch = "main";
			prTitle = currentBranch;
			await openGitHubPRInBrowser(
				prDescription,
				prTitle,
				repoUrl,
				currentBranch,
				baseBranch,
			);
		} else if (argv.gh) {
			let currentBranch = await executeCommand(
				"git rev-parse --abbrev-ref HEAD",
				"Getting current branch...",
				false,
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
								"AI failed to generate a branch name. Falling back to manual input with AI-suggested type.",
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
								const suggestedType =
									await generateAIBranchType(commitMessages);
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
							"Skipping AI branch name generation. Suggesting type based on commits.",
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
							`Failed to create and switch to new branch: ${error.message}`,
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
				argv,
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
