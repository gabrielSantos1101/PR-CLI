# PR-CLI

A simple and powerful Command Line Interface (CLI) tool designed to streamline the process of generating Git Pull Request (PR) descriptions. By analyzing your local Git commit history and leveraging AI, PR-CLI helps you create clear, concise, and comprehensive PR descriptions, optionally using predefined templates and supporting multiple languages.

## Features

- **Automated PR Description Generation:** Analyzes your Git commit history to automatically generate a structured PR description.
- **Conventional Commit Support:** Categorizes commit messages based on conventional commit prefixes (feat, fix, chore, docs, etc.) into organized sections.
- **PR Template Integration:** Automatically detects and allows you to select from `.github/PULL_REQUEST_TEMPLATE` markdown files to structure your PR description.
- **AI-Enhanced Content Generation:** Utilizes Google Gemini to intelligently fill in template sections and refine the PR description based on your commit messages.
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

- `--github`: Generates a GitHub link with the PR template pre-filled.

  ```bash
  pr-cli --github
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
3.  **Select a template (if available):** If you have PR templates in `.github/PULL_REQUEST_TEMPLATE/` or `.github/`, you will be prompted to choose one.
4.  **Select template language (if a template is chosen):** You will be prompted to select the language of your chosen PR template.
5.  **Review and copy:** The generated PR description will be displayed in your terminal. If you used the `--copy` flag, it will also be in your clipboard.

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
