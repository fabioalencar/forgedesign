/**
 * This build's version — what `forge --version` prints, what a Check report
 * records as doctor's version, and the `forge-cli/<version>` a generated
 * concept names as its generator (TASK-542).
 *
 * It was written out three times beside `package.json`'s, so a release would
 * have had to find all four. A test holds this one equal to the package's.
 */
export const CLI_VERSION = "0.1.2";
