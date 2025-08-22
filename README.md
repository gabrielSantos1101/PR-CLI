# PR Description Generator

A simple CLI tool to generate a Git Pull Request (PR) description by analyzing your local Git commit history.

## Installation

1.  Clone the repository or download the source code.
2.  Navigate to the project directory.
3.  Install the dependencies:
    ```bash
    npm install
    ```
4.  Make the CLI executable:
    ```bash
    chmod +x index.js
    ```
5. (Optional) Create a symbolic link to make the command globally available:
    ```bash
    npm link
    ```

## Usage

To generate a PR description, run the following command from within your Git repository:

```bash
./index.js
```

Or, if you have linked the package:
```bash
generate-pr-desc
```

### Options

-   `--copy`, `-c`: Copy the generated PR description to your clipboard.

    ```bash
    ./index.js --copy
    ```

### How it Works

The tool gets all the commit messages from your current branch that are not in the `main` branch. It then categorizes them based on conventional commit prefixes (e.g., `feat:`, `fix:`, `chore:`). Finally, it generates a formatted PR description with sections for each category.
