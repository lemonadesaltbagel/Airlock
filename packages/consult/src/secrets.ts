import type { GateFinding } from "./types.js";

interface SecretPattern {
  name: string;
  regex: RegExp;
}

/**
 * Credentials and identifying infrastructure details. Deliberately broad: a false positive
 * costs one rewrite, a false negative leaks a secret.
 */
const PATTERNS: SecretPattern[] = [
  { name: "Anthropic API key", regex: /sk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: "OpenAI-style API key", regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: "AWS access key id", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "GitHub token", regex: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { name: "Slack token", regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: "Google API key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "private key block", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: "JSON web token", regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { name: "email address", regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { name: "home directory path", regex: /(?:\/Users|\/home)\/[A-Za-z0-9._-]+/g },
  { name: "Windows user path", regex: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/g },
  { name: "private IPv4 address", regex: /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g },
  { name: "hard-coded password", regex: /\b(?:password|passwd|secret|api_?key|token)\s*[:=]\s*["'][^"'\s]{6,}["']/gi },
];

/** Placeholder hosts and addresses that are safe in examples. */
const ALLOWED = [/@example\.(?:com|org|net)$/i, /^\/home\/user$/, /^\/Users\/user$/];

export function findSecrets(text: string): GateFinding[] {
  const findings: GateFinding[] = [];
  for (const { name, regex } of PATTERNS) {
    for (const m of text.matchAll(regex)) {
      if (ALLOWED.some((a) => a.test(m[0]))) continue;
      findings.push({ rule: "secret", match: m[0], detail: name });
    }
  }
  return findings;
}
