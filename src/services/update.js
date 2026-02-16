import fs from "fs/promises";
import path from "path";
import os from "os";
import ora from "ora";
import inquirer from "inquirer";
import { UPDATE_CHECK_INTERVAL } from "../constants.js";
import { isVersionOlder, executeCommand } from "../utils/helpers.js";
import packageJson from "../../package.json" assert { type: "json" };

const fetch = globalThis.fetch;

if (typeof fetch !== "function") {
  throw new Error("Fetch API requires Node.js 18 or newer.");
}

const PACKAGE_VERSION = packageJson.version;
const PACKAGE_NAME = packageJson.name;

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
 * Checks for updates to the package.
 * @returns {Promise<boolean>} True if an update is available.
 */
export async function checkForUpdates() {
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

/**
 * Handles the update process if an update is available.
 * @param {boolean} updateAvailable Whether an update is available.
 * @returns {Promise<void>}
 */
export async function handleUpdate(updateAvailable) {
  if (!updateAvailable) {
    return;
  }

  const { confirmUpdate } = await inquirer.prompt([
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
