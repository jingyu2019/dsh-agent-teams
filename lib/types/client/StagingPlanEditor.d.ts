/**
 * Editable pre-run roster and DAG review for staged AgentTeams plans.
 *
 * This leaf owns only transient form/disclosure state. Durable truth remains
 * on the host and returns through the ordinary activity polling snapshot.
 * @module dsh-agent-teams/client/staging-plan
 */
import type { ModelDirectory } from '@deepseek-ai/dsh-client-ui-model-selection/client';
import type { ActivityTeam } from './activity-monitor.ts';
import type { AgentTeamsTranslate } from './locales.ts';
type PlanModelSelection = {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort: string;
};
/**
 * Thin staged-plan adapter over the official model directory. It deliberately
 * reads only catalog metadata: choosing a member route must not change the
 * captain session's composer model.
 */
export declare function StagedModelPicker({ directory, provider, model, reasoningEffort, busy, onChange, t, }: {
    readonly directory: ModelDirectory;
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort: string;
    readonly busy: boolean;
    readonly onChange: (selection: PlanModelSelection) => void;
    readonly t: AgentTeamsTranslate;
}): import("react").JSX.Element;
export declare function StagingPlanEditor({ team, modelDirectory, onContinuePlanning, onDiscarded, t }: {
    readonly team: ActivityTeam;
    readonly modelDirectory: ModelDirectory;
    readonly onContinuePlanning: () => void;
    readonly onDiscarded: () => void;
    readonly t: AgentTeamsTranslate;
}): import("react").JSX.Element;
export {};
