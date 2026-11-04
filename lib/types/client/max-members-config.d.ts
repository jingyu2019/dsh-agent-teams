/** The staged write produced by a maxMembers text field. */
export type MaxMembersFieldWrite = {
    kind: 'clear';
} | {
    kind: 'set';
    value: number;
};
/**
 * Parse one team-size draft using the Config schema's natural().min(1) rule.
 * Empty text clears the user override; invalid values prevent the form save.
 *
 * @param text - draft value displayed by the settings field.
 * @returns a host write or undefined when the draft is invalid.
 */
export declare function parseMaxMembersDraft(text: string): MaxMembersFieldWrite | undefined;
