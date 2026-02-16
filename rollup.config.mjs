import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import terser from "@rollup/plugin-terser";

export default {
  input: "src/cli.js",
  output: {
    file: "dist/index.js",
    format: "es",
    banner: "#!/usr/bin/env node",
  },
  external: [
    "child_process",
    "fs",
    "fs/promises",
    "path",
    "os",
    "module",
    "url",
    /@google\/generative-ai/,
    /@inquirer/,
    /^clipboardy/,
    /^inquirer/,
    /^ora/,
    /^yargs/,
  ],
  plugins: [
    resolve({
      preferBuiltins: true,
    }),
    commonjs(),
    json(),
    terser({
      ecma: 2020,
      module: true,
      compress: {
        passes: 2,
        unsafe: false,
      },
      mangle: {
        keep_classnames: true,
        keep_fnames: false,
      },
      format: {
        comments: false,
      },
    }),
  ],
};
