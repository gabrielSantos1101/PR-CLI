import fs from "fs/promises";
import path from "path";
import inquirer from "inquirer";
import { COMMIT_TYPES } from "../constants.js";
import { executeCommand } from "../utils/helpers.js";

/**
 * Checks for Pull Request templates in the `.github` folder.
 * @returns {Promise<string[]>} An array of template file paths.
 */
export async function getPRTemplates() {
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
 * Prompts the user to choose a PR template.
 * @param {string[]} templates An array of template file paths.
 * @returns {Promise<string|null>} The content of the chosen template.
 */
export async function chooseTemplate(templates) {
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
 * Generates the PR description based on categorized commits and template.
 * @param {Object.<string, string[]>} categorizedCommits Categorized commit messages.
 * @param {string|null} templateContent Optional content from a PR template.
 * @returns {string} The formatted PR description.
 */
export function generatePRDescription(categorizedCommits, templateContent = null, devDescription = "", commitFullMessages = []) {
  if (templateContent) {
    return fillTemplate(categorizedCommits, templateContent, devDescription, commitFullMessages);
  }

  let prBody = "";

  const allCommitLists = Object.values(categorizedCommits)
    .flat()
    .filter(Boolean);

  const totalCommits = allCommitLists.length;

  if (totalCommits > 0) {
    const summary = allCommitLists.slice(0, 3).map(c => c.replace(/^- /, '')).join(", ");
    const rest = totalCommits - 3;
    prBody += `## Summary\n\n`;
    prBody += `${totalCommits} change(s) in this PR`;
    prBody += `: ${summary}`;
    if (rest > 0) {
      prBody += ` and ${rest} more`;
    }
    prBody += `.\n\n`;
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
 * Fills a PR template with categorized commit data, preserving the template structure.
 * @param {Object.<string, string[]>} categorizedCommits
 * @param {string} templateContent
 * @returns {string}
 */
function fillTemplate(categorizedCommits, templateContent, devDescription = "", commitFullMessages = []) {
  const allCommits = Object.values(categorizedCommits)
    .flat()
    .filter(Boolean);

  if (allCommits.length === 0) {
    return templateContent.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim();
  }

  const totalCommits = allCommits.length;
  const summary = allCommits.slice(0, 3).map(c => c.replace(/^- /, '')).join(", ");
  const rest = totalCommits - 3;
  let summaryLine = `${totalCommits} change(s) in this PR: ${summary}`;
  if (rest > 0) summaryLine += ` and ${rest} more`;
  summaryLine += '.';

  const items = [];
  for (const section in COMMIT_TYPES) {
    const sectionTitle = COMMIT_TYPES[section];
    if (categorizedCommits[sectionTitle]?.length > 0) {
      items.push(`- **${sectionTitle}:** ${categorizedCommits[sectionTitle].map(c => c.replace(/^- /, '')).join(', ')}`);
    }
  }
  if (categorizedCommits["Other Changes"]?.length > 0) {
    categorizedCommits["Other Changes"].forEach(c => items.push(`- ${c.replace(/^- /, '')}`));
  }
  const changesText = items.join('\n');

  let content = templateContent.replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '');

  const hasDevDescription = devDescription && devDescription.trim().length > 0;

  const lines = content.split('\n');
  const output = [];
  let replacedDesc = false;
  let replacedChanges = false;
  let replacedWhy = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!replacedChanges && /^###\s+What\s+was\s+changed\??\s*$/i.test(line.trim())) {
      output.push(line);
      output.push('');
      output.push(changesText);
      let j = i + 1;
      while (j < lines.length && !/^#{1,3}\s/.test(lines[j].trim())) j++;
      i = j - 1;
      replacedChanges = true;
      continue;
    }

    if (!replacedWhy && hasDevDescription && /^###\s+Why\??\s*$/i.test(line.trim())) {
      output.push(line);
      output.push('');
      output.push(`- ${devDescription.trim()}`);
      let j = i + 1;
      while (j < lines.length && !/^#{1,3}\s/.test(lines[j].trim())) j++;
      i = j - 1;
      replacedWhy = true;
      continue;
    }

    if (!replacedDesc && !/^#/.test(line.trim()) && line.trim() !== '' &&
        i > 0 && /^##[^#]/.test(lines[i - 1].trim())) {
      output.push(summaryLine);
      replacedDesc = true;
      continue;
    }

    if (!replacedDesc && !/^#/.test(line.trim()) && line.trim() !== '' &&
        i > 1 && lines[i - 1].trim() === '' && /^##[^#]/.test(lines[i - 2].trim())) {
      output.push(summaryLine);
      replacedDesc = true;
      continue;
    }

    output.push(line);
  }

  return cleanTemplate(output.join('\n'));
}

/**
 * Removes placeholder/instructional text from template sections that weren't filled.
 * Keeps all section headings, checkboxes, list items, and structural elements.
 */
function cleanTemplate(content) {
  const placeholderPatterns = [
    /ISSUE_NUMBER/,
    /Root cause of the bug/,
    /Bugfix or refactor\. Summarize/,
    /Describe clearly and objectively/,
    /Affected areas \(components/,
    /Relevant visual or behavioral/,
    /Motivation for the refactor/,
    /\(e\.g\., fixes #\d+\)/,
    /Logs, screenshots, or GIFs/,
    /Known risks, trade-offs/,
    /Extra information for reviewers/,
    /If applicable, add screenshots/,
  ];

  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const cleaned = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    let isPlaceholder = false;
    for (const pattern of placeholderPatterns) {
      if (pattern.test(trimmed)) {
        isPlaceholder = true;
        break;
      }
    }
    if (isPlaceholder) continue;

    if (/^-\s*$/.test(trimmed)) continue;

    cleaned.push(line);
  }

  return cleaned.join('\n').replace(/\n{4,}/g, '\n\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Fetches the current PR description from an existing PR using GitHub CLI.
 * @param {string} branchName The branch name to check for existing PR.
 * @returns {Promise<string|null>} The current PR body or null if no PR exists.
 */
export async function getExistingPRDescription(branchName) {
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
