/**
 * Sensitive outbound detection (pure domain logic).
 *
 * Two layers: sensitive *paths* (never copied without an explicit override,
 * regardless of ignore rules) and a deliberately small set of high-signal
 * sensitive *content* patterns (private key blocks, AWS access key ids,
 * GitHub tokens). Both are overridden only through an explicit human action.
 */

/**
 * Built-in sensitive path patterns, effective even without project
 * configuration. Mirrors the credential entries of the generated `.ctxignore`
 * template plus the `secrets/` convention shown in the config template.
 */
export const DEFAULT_SENSITIVE_PATTERNS: string[] = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "id_rsa*",
  "id_ed25519*",
  "secrets/",
];

/** High-signal content patterns that mark a whole file as sensitive. */
export const SENSITIVE_CONTENT_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9]{36}/,
];

/** True when `content` contains an obvious sensitive pattern. */
export function containsSensitiveContent(content: string): boolean {
  return SENSITIVE_CONTENT_PATTERNS.some((re) => re.test(content));
}
