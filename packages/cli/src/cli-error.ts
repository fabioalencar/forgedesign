// How a command says no (TASK-541, DDR-157).
//
// A command that refuses — bad input, a precondition not met, the service
// saying no — throws a `CliError` with the sentence the user reads, and the
// bin's one catch in `index.ts` prints it to stderr and exits with its code.
// Commands used to do that in two ways: some threw, and 22 sites printed with
// `console.error`, set `process.exitCode = 1` and returned, which
// is easy to get half right (a missing `return` carries on, a missing
// `exitCode` reports success) and impossible to test without spawning the bin.
//
// What is not a refusal stays as it is: a command that ran and reports a
// result through its exit code — doctor's 0/1/2, `upgrade` finishing with files
// it could not write, `dash` passing on the dev server's code — sets
// `process.exitCode` as data, after printing the result.

export class CliError extends Error {
  constructor(
    message: string,
    /** what the process exits with; 1 unless a command documents another */
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}

/** The text of anything thrown, for a refusal that wraps it. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
