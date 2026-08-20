/**
 * Single build-time source of truth for all public product names and markers.
 *
 * The product name, executable name, request marker, response marker, and
 * generated configuration file names must stay derived from this module so
 * that a rename is one edit and nothing else drifts.
 */

export const PRODUCT_NAME = "ctx";
export const EXECUTABLE_NAME = "ctx";
export const REQUEST_MARKER = "@ctx";
export const RESPONSE_MARKER = "# CTX RESPONSE";
export const CONFIG_FILE_NAME = ".ctx.toml";
export const IGNORE_FILE_NAME = ".ctxignore";
export const VERSION = "0.1.0";
