const HELP_PATTERNS = [
  /\b(?:how (?:do|can) i |where (?:do|can) i )?(?:log ?out|sign ?out)\b/i,
  /\b(?:delete|remove|close) (?:my )?account\b/i,
  /\b(?:export|download) (?:my )?(?:data|information)\b/i,
  /\b(?:contact|customer) support\b/i,
  /\b(?:privacy policy|terms (?:of service|and conditions))\b/i,
];

/** Keep product/account questions out of the goal-creation interview. */
export function isProductHelpRequest(text: string): boolean {
  return HELP_PATTERNS.some((pattern) => pattern.test(text.trim()));
}
