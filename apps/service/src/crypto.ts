import { createHash, randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(nodeScrypt);

export function randomCredential(): string {
  return randomBytes(32).toString("base64url");
}

export function hashEnrollmentToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function hashCanonicalPayload(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

export async function hashCredential(credential: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(credential, salt, 32) as Buffer;
  return `scrypt:${salt.toString("base64url")}:${derived.toString("base64url")}`;
}

export async function verifyCredential(credential: string, encoded: string): Promise<boolean> {
  const [algorithm, saltText, expectedText] = encoded.split(":");
  if (algorithm !== "scrypt" || !saltText || !expectedText) return false;
  const expected = Buffer.from(expectedText, "base64url");
  const actual = await scrypt(credential, Buffer.from(saltText, "base64url"), expected.length) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([entryKey, entryValue]) => `${JSON.stringify(entryKey)}:${canonicalJson(entryValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
