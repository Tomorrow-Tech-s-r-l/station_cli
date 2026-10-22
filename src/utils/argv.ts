/**
 * Remove every occurrence of a value-taking flag (`-x v`, `--long v`,
 * `--long=v`) from argv, stopping at `--`, and return the values in order.
 * Used for global options that must be resolved before Commander parses.
 *
 * @param argv - process.argv (mutated in place)
 * @param short - short form, e.g. "-m"
 * @param long - long form, e.g. "--model"
 * @param what - value description for the "requires a ..." error
 */
export function takeFlag(argv: string[], short: string, long: string, what: string): string[] {
  const values: string[] = [];
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") break;
    if (arg === short || arg === long) {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} requires ${what}`);
      values.push(value);
      argv.splice(i, 2);
    } else if (arg.startsWith(`${long}=`)) {
      values.push(arg.slice(long.length + 1));
      argv.splice(i, 1);
    } else {
      continue;
    }
    i--;
  }
  return values;
}
