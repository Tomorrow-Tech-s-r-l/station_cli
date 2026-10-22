import { inspect } from "node:util";

/**
 * A credential that cannot leak by accident.
 *
 * Redaction here is structural rather than a regex over output: the value is
 * held in a private field and every way JavaScript has of turning an object
 * into text — `JSON.stringify`, `String()`, template literals, `console.log`,
 * `util.inspect` — yields a placeholder. The only way to get the value is to
 * ask for it by name with `reveal()`, which makes every use of a secret
 * greppable and reviewable.
 *
 * This matters because the CLI's whole output contract is "print one JSON
 * document", and that document echoes the effective configuration back for
 * debugging. A plain string token in that config would be one careless spread
 * away from landing in the kiosk's logs and every support bundle.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The raw value. Call only at the point of use, never to log or store. */
  reveal(): string {
    return this.#value;
  }

  /** True when a non-empty value is held. */
  get present(): boolean {
    return this.#value.length > 0;
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

export const REDACTED = "<redacted>";

/** Wraps a raw string, treating empty/blank as absent. */
export function secretFrom(value: unknown): Secret | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? new Secret(trimmed) : null;
}
