/** Durable delivery receipts and execution-generation filtering at step admission. */
import type { Context } from '@deepseek-ai/cordis';
import { type ActivationLease, type TeamMessage, type TeamState } from './types.ts';
/** Bounded best-effort wait for a final report at native settlement. */
export declare const FINAL_REPORT_GRACE_MS = 500;
export declare function isCurrentMail(team: TeamState, message: TeamMessage): boolean;
/** Exact final-report predicate used by native settlement suppression. */
export declare function isFinalReportForSettlement(team: TeamState, message: TeamMessage, childId: string, lease: Pick<ActivationLease, 'activationId' | 'memberId' | 'memberGeneration'>): boolean;
/** Include structured provenance even in the status-tool fallback presentation. */
export declare function mailboxContent(message: TeamMessage): string;
/** Fallback reads must enforce the same current-generation rule as live admission. */
export declare function readCurrentMailbox(root: string, teamId: string, recipient: string, onMalformed?: (line: number) => void): Promise<TeamMessage[]>;
export declare function mailboxPrompt(teamId: string, recipient: string, messages: readonly TeamMessage[]): string;
/** Only messages actually admitted to this recipient's step become read. */
export declare function installMailboxAdmission(ctx: Context, stateDir: string): void;
