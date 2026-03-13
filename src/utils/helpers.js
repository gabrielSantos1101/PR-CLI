import { exec, spawn } from "child_process";
import ora from "ora";
import { debug } from "./debug.js";

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
  debug(`Executing: ${command}`);
  const spinner = ora(spinnerText).start();
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        spinner.fail(`Command failed: ${command}`);
        console.error(`exec error: ${error}`);
        debug(`Command error stack: ${error.stack}`);
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
      debug(`stdout (${stdout.trim().length} chars): ${stdout.trim().substring(0, 200)}${stdout.trim().length > 200 ? "..." : ""}`);
      resolve(stdout.trim());
    });
  });
}

/**
 * Executes a shell command with the terminal attached (stdin/stdout/stderr inherited).
 * Use this for interactive commands that may prompt for input (e.g. gh auth).
 * @param {string} command The command to execute.
 * @param {string} spinnerText Text shown before handing off the terminal.
 * @returns {Promise<void>}
 */
export async function executeInteractiveCommand(command, spinnerText = "") {
  debug(`Executing interactive: ${command}`);
  if (spinnerText) {
    const spinner = ora(spinnerText).start();
    spinner.stop();
  }
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = command.split(/\s+(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    const child = spawn(cmd, args, { stdio: "inherit", shell: true });
    child.on("close", (code) => {
      if (code !== 0) {
        const error = new Error(`Command exited with code ${code}: ${command}`);
        debug(`Interactive command failed with code ${code}`);
        return reject(error);
      }
      debug(`Interactive command completed: ${command}`);
      resolve();
    });
    child.on("error", (error) => {
      debug(`Interactive command error: ${error.message}`);
      reject(error);
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
