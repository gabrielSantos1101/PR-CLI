const { executeCommand, isValidCommitHash } = require("./helpers");
const ora = require("ora").default;

/**
 * Truncates a diff to a maximum size while preserving structure.
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
 * Filters binary file content from git diff output.
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
 * Checks if a commit is a merge commit by examining its parent count.
 * @param {string} commitHash The commit hash to check.
 * @returns {Promise<boolean>} True if the commit is a merge commit, false otherwise.
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
 * @param {string[]} commitHashes Array of commit SHA hashes.
 * @param {Object} options Configuration object.
 * @returns {Promise<Array<{hash: string, content: string, truncated: boolean, error: string|null}>>}
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
 * Gets the Git commit history.
 * @param {number} [count] The number of commits to retrieve from HEAD.
 * @param {Object} [options={}] Configuration options.
 * @returns {Promise<string[]|{messages: string[], hashes: string[], count: number}>}
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

module.exports = {
  truncateDiff,
  filterBinaryFiles,
  isMergeCommit,
  getCommitDiffs,
  getCommitHistory,
};
