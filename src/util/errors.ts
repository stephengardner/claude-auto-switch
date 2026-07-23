/**
 * Typed error hierarchy. Every error the tool throws on purpose extends
 * `CasError`, so callers (and the CLI top-level handler) can distinguish an
 * expected, explainable failure from an unexpected crash.
 */
export class CasError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Config file is missing required shape or has invalid values. */
export class ConfigError extends CasError {}

/** Registry (accounts.json) operation failed (duplicate name, unknown account). */
export class RegistryError extends CasError {}

/** `claude auth status` output could not be parsed. */
export class AuthStatusParseError extends CasError {}

/** No usable account could be selected. */
export class NoAccountError extends CasError {}

/** The real claude binary could not be resolved. */
export class RealClaudeError extends CasError {}

/** An account name or path failed validation (traversal, separators, reserved). */
export class InvalidNameError extends CasError {}
