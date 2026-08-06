import { createHash } from "node:crypto";

/**
 * The single definition of what never leaves the machine, grouped so that a reader can
 * check the README and the docs against it line by line. Both ends check it: on the way
 * out before capture, and on the way in through @crosscode/sync.
 *
 * A false positive is silent -- the file simply stops syncing and nobody is told why --
 * so every pattern is anchored to a path segment or to a file extension rather than
 * matching anywhere in the path. `src/keyboard.ts`, `docs/api-keys-guide.md` and
 * `lib/secretsanta.js` are ordinary source files and must keep syncing.
 */
const SECRET_PATH_PATTERNS = [
  // Environment files, and the tool configs that habitually hold tokens.
  /(^|\/)\.env($|\.)/i,
  /(^|\/)\.(envrc|npmrc|netrc|pgpass|htpasswd|pypirc|dockercfg|git-credentials)$/i,
  // Directories whose whole purpose is credentials.
  /(^|\/)\.(aws|ssh|gnupg|kube)(\/|$)/i,
  // Private keys by name.
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  // A path segment that is itself a credential store: credentials, secrets.yml, secrets/.
  /(^|\/)(credentials?|secrets?)($|[./])/i,
  // ...and the same word carried inside a filename: aws-credentials.json, db_credential.txt.
  /[-_]credentials?($|[-_./])/i,
  /service[-_]account[^/]*\.(json|ya?ml|pem|p12)$/i,
  /(^|\/)kubeconfig([-_.][^/]*)?$/i,
  // Keys, keystores and encrypted or armoured key material by extension.
  /\.(pem|key|p8|p12|pfx|jks|jceks|keystore|keytab|ppk|kdbx|ovpn|asc|gpg|pgp)$/i,
  // Terraform: variables and state both routinely carry plaintext secrets.
  /\.tfvars(\.json)?$/i,
  /\.tfstate(\.backup)?$/i
];

export function contentHash(content: string | Buffer): string { return createHash("sha256").update(content).digest("hex"); }
export function redactPath(path: string): boolean {
  return SECRET_PATH_PATTERNS.some((pattern) => pattern.test(path));
}
