import { exec } from "child_process";
import ora from "ora";

/**
 * Executes a shell command and returns its output.
 * @param {string} command The command to execute.
 * @returns {Promise<string>} The command's stdout.
 */
export async function executeCommand(
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
 * Validates if a string is a valid Git commit hash format.
 * @param {string} hash The commit hash to validate.
 * @returns {boolean} True if the hash format is valid, false otherwise.
 */
export function isValidCommitHash(hash) {
  if (typeof hash !== 'string') {
    return false;
  }
  return /^[0-9a-f]{7,40}$/i.test(hash.trim());
}

/**
 * Compares two semantic version strings.
 * @param {string} v1 Version string 1.
 * @param {string} v2 Version string 2.
 * @returns {boolean} True if v1 is older than v2, false otherwise.
 */
export function isVersionOlder(v1, v2) {
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
