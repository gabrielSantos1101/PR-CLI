# PR-CLI

A simple and powerful Command Line Interface (CLI) tool designed to streamline the process of generating Git Pull Request (PR) descriptions. By analyzing your local Git commit history and leveraging AI, PR-CLI helps you create clear, concise, and comprehensive PR descriptions, optionally using predefined templates and supporting multiple languages.

## Architecture

PR-CLI operates by first analyzing your local Git commit history to extract relevant information. It then leverages an AI model (Google Gemini) to process this information, optionally integrating with predefined PR templates. The tool intelligently fills in template sections and refines the PR description based on your commit messages and chosen language, ultimately providing a structured and comprehensive output.

### Smart Update Mode Flow

When you use `--read` on a branch with an existing PR, the tool follows this optimized workflow:

1. **Detection:** Checks if a PR already exists for the current branch
2. **Context Retrieval:** Fetches the existing PR description using GitHub CLI
3. **Incremental Analysis:** Analyzes only the NEW commits since the last update
4. **Smart Generation:** AI receives:
   - The existing PR description (as context)
   - New commit messages
   - New code diffs (if `--read` is used)
   - Developer's description of new work
5. **Intelligent Update:** AI updates the PR by:
   - Keeping all existing relevant content
   - Adding information about new changes
   - Updating sections that need to reflect new changes
   - Maintaining consistency with the existing style

**Benefits:**
- Reduces token usage by ~60-80% on PR updates
- Maintains consistency across PR updates
- Preserves manually edited sections when possible
- Faster generation times
- Better context for the AI

**Example Scenario:**

```bash
# First PR creation
$ pr-cli --gh --read --self
✓ Commit history fetched.
✓ Fetched diffs for 3 commits (12,450 characters)
✓ AI-enhanced PR description generated.
✓ Pull Request created successfully via GitHub CLI.

# Later, after adding 2 more commits
$ pr-cli --gh --read --refill
✓ Commit history fetched.
✓ Found existing PR description. Will use it as context for updates.
✓ Fetched diffs for 2 commits (4,230 characters)  # Only new commits!
✓ AI-enhanced PR description generated.
✓ Pull Request description updated successfully.

# Token usage comparison:
# Without optimization: ~15,000 tokens (all 5 commits + diffs)
# With optimization: ~6,000 tokens (existing PR + 2 new commits)
# Savings: 60% reduction in token usage!
```

## Features

- **Automated PR Description Generation:** Analyzes your Git commit history to automatically generate a structured PR description.
- **Conventional Commit Support:** Categorizes commit messages based on conventional commit prefixes (feat, fix, chore, docs, etc.) into organized sections.
- **PR Template Integration:** Automatically detects and allows you to select from `.github/PULL_REQUEST_TEMPLATE` markdown files to structure your PR description.
- **AI-Enhanced Content Generation:** Utilizes Google Gemini to intelligently fill in template sections and refine the PR description based on your commit messages.
- **Smart Update Mode:** When using `--read` on an existing PR, automatically uses the current PR description as context to generate incremental updates, reducing token usage and maintaining consistency.
- **Multi-language Support:** Allows you to specify the language of your PR template, enabling the AI to generate descriptions in the chosen language.
- **Clipboard Integration:** Automatically copies the generated PR description to your clipboard for easy pasting.

## Installation

You can install `pr-cli-generator` via npm:

```bash
npm install -g pr-cli-generator
```

## Usage

After installation, you can use the `pr-cli` command in your Git repository:

```bash
pr-cli
```

### Options

- `-c`, `--copy`: Automatically copy the generated PR description to the clipboard.

  ```bash
  pr-cli --copy
  ```

- `-d`, `--description <text>`: Provide a manual description to enhance the generated PR description.

  ```bash
  pr-cli --description "This PR adds a new feature for user authentication."
  ```

- `-r`, `--read`, `-rmd`: Include commit diffs (actual code changes) for more detailed and accurate PR descriptions. This provides the AI with richer context about what was changed, enabling it to generate more comprehensive descriptions based on the actual code modifications.

  ```bash
  pr-cli --read
  ```

  **Smart Update Mode:**
  
  When using `--read` on a branch with an existing PR, the tool automatically:
  - Fetches the current PR description
  - Uses it as context for the AI
  - Only adds information about NEW changes
  - Preserves existing content that's still relevant
  - Updates sections that need to reflect new changes
  
  This optimization significantly reduces token usage and provides more consistent PR descriptions across updates.

  **Additional option:**
  
  - `-rmd`: Include diffs from merge commits. By default, merge commits are excluded to reduce noise.
    ```bash
    pr-cli -rmd
    ```

  **Benefits:**
  - More accurate PR descriptions that reflect actual code changes
  - Better context for complex refactoring or architectural changes
  - Useful when commit messages are brief or don't capture all details
  - Automatic optimization: large diffs are intelligently truncated to prevent token limit issues
  
  **How it works:**
  - Diffs larger than 8KB are automatically truncated while preserving file headers and structure
  - Each file shows up to 40 lines of changes to maintain context while saving tokens
  - Binary files are automatically filtered out
  - You'll see clear indicators when content is truncated
  
  **Examples:**
  ```bash
  # Basic usage with code diffs
  pr-cli -r
  
  # Update existing PR with new changes (automatically uses existing PR as context)
  pr-cli -r --gh --refill
  
  # Include merge commits
  pr-cli -rmd
  
  # Combine with GitHub PR creation
  pr-cli --gh --read --self
  ```
  
  **Note:** This option adds 1-10 seconds to generation time depending on the number and size of commits.

- `--github` (or `-g`): Opens a GitHub PR page in your browser with the PR title and description pre-filled in the URL. The full PR description is also copied to your clipboard, and you'll be instructed to paste it into the description field on the GitHub page.
  ```bash
  pr-cli --github
  ```
- `--gh`: Creates a GitHub PR directly using the GitHub CLI. This option also includes branch management features (prompting to create/publish a new branch if on `main`/`master` or if the branch is not published).
  ```bash
  pr-cli --gh
  ```
- `--refill`: When a PR already exists for the current branch, overwrite its description with the newly generated content **without** asking for confirmation (useful in CI or scripted runs). The overwrite prompt is always shown in English when this flag is not used.
  ```bash
  pr-cli --gh --refill
  ```
- `--self`: Assign the PR to yourself.
  ```bash
  pr-cli --gh --self
  ```
- `--draft`: Create the PR as a draft.
  ```bash
  pr-cli --gh --draft
  ```

### Setup Google Gemini API Key

Obtain a `GEMINI_API_KEY` from Google AI Studio.
Set it as an environment variable:

```bash
# For Linux/macOS
export GEMINI_API_KEY="YOUR_GEMINI_API_KEY"

# For Windows (Command Prompt)
set GEMINI_API_KEY="YOUR_GEMINI_API_KEY"

# For Windows (PowerShell)
$env:GEMINI_API_KEY="YOUR_GEMINI_API_KEY"
```

Alternatively, you can create a `.env` file in the project root with `GEMINI_API_KEY=YOUR_GEMINI_API_KEY`.

### Workflow

1.  **Commit your changes:** Ensure your commit messages follow a consistent convention (e.g., Conventional Commits).
2.  **Run PR-CLI:** Execute `node index.js` in your repository.
3.  **Handle No Local Commits:** If no local commits are found, you will be prompted to specify how many remote commits to read for history.
4.  **Select a template (if available):** If you have PR templates in `.github/PULL_REQUEST_TEMPLATE/` or `.github/`, you will be prompted to choose one.
5.  **Select template language (if a template is chosen):** You will be prompted to select the language of your chosen PR template.
6.  **Branch Management (for `--gh` option):** If using the `--gh` option and on `main`/`master` or an unpublished branch, you will be prompted to create and/or publish a new branch.
7.  **Review and copy / Create PR:**
    - If using `--github`, the generated PR description will be displayed, and the GitHub PR URL and full description will be copied to your clipboard.
    - If using `--gh`, the PR will be created directly via GitHub CLI.

### Common Usage Examples

#### Basic PR generation
```bash
pr-cli
```

#### With code analysis (recommended)
```bash
pr-cli --read
```

#### Update existing PR with new commits (Smart Update Mode)
```bash
# The tool automatically detects the existing PR and uses it as context
pr-cli --read --gh --refill

# This will:
# 1. Fetch your existing PR description
# 2. Get only the NEW commits since last update
# 3. Ask AI to update the PR preserving existing content
# 4. Update the PR without confirmation (--refill flag)
```

#### Include merge commits
```bash
pr-cli --read -rmd
```

#### Create GitHub PR directly with code analysis
```bash
pr-cli --gh --read --self
```

#### Copy to clipboard with code context
```bash
pr-cli --copy --read
```

## PR Template Example

You can create PR templates in markdown files within `.github/PULL_REQUEST_TEMPLATE/` or directly in `.github/`.

Example: `.github/PULL_REQUEST_TEMPLATE/standard.md`

```markdown
## Description

<!-- Briefly describe the changes introduced by this PR. -->

## Related Issues

<!-- Link any related issues (e.g., #123, #BUG-456). -->

## Type of change

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] This change requires a documentation update

## Checklist:

- [ ] My code follows the style guidelines of this project
- [ ] I have performed a self-review of my own code
- [ ] I have commented my code, particularly in hard-to-understand areas
- [ ] I have made corresponding changes to the documentation
- [ ] My changes generate no new warnings
- [ ] I have added tests that prove my fix is effective or that my feature works
- [ ] New and existing unit tests pass locally with my changes
- [ ] Any dependent changes have been merged and published in downstream modules
```

## Contributing

Contributions are welcome! Please feel free to open issues or submit pull requests.

## License

This project is licensed under the ISC License.
