/**
 * Parse one team-size draft using the Config schema's natural().min(1) rule.
 * Empty text clears the user override; invalid values prevent the form save.
 *
 * @param text - draft value displayed by the settings field.
 * @returns a host write or undefined when the draft is invalid.
 */
export function parseMaxMembersDraft(text) {
    const trimmed = text.trim();
    if (trimmed === '')
        return { kind: 'clear' };
    const value = Number(trimmed);
    return Number.isSafeInteger(value) && value >= 1
        ? { kind: 'set', value }
        : undefined;
}
