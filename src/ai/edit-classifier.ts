import type { MessageEditAssessment } from '../discord/utils/message-edits';
import { Agent } from '@openai/agents';
import { z } from 'zod';
import { CLASSIFIER_TIMEOUT_MS } from '../constants';
import {
  assessMessageEdit,

} from '../discord/utils/message-edits';
import { aiLogger } from '../logger';
import { agentsRuntimeManager } from './client';

const EditDecisionSchema = z.object({
  meaningful: z.boolean(),
  should_regenerate: z.boolean(),
  reason: z.string(),
});

const EDIT_CLASSIFIER_PROMPT = `You classify a Discord user's message edit after an assistant has already replied.

Decide:
- meaningful: whether the edited message changes what a good assistant response should say.
- should_regenerate: whether it is safe to regenerate and edit the assistant's prior reply automatically.

Treat spelling, casing, punctuation, grammar cleanup, and wording polish as not meaningful when the request/meaning is unchanged.
Set should_regenerate=false if regenerating could repeat an external action, moderation action, write operation, purchase, post, deletion, role/server change, GitHub write, or any other side effect. In those cases the bot should update its context but not redo the action from an edit.
Set should_regenerate=true for ordinary questions, explanations, factual corrections, image/content questions, time/date questions, and other answer-only edits.

Return only the structured decision.`;

class EditClassifier {
  async classifyEdit(
    before: string,
    after: string,
  ): Promise<MessageEditAssessment> {
    const deterministic = assessMessageEdit(before, after);
    if (deterministic.reason !== 'needs_semantic_classification') {
      return deterministic;
    }

    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(),
      CLASSIFIER_TIMEOUT_MS,
    );

    try {
      const agent = new Agent({
        name: 'Ruyi message edit classifier',
        instructions: EDIT_CLASSIFIER_PROMPT,
        model: agentsRuntimeManager.getBackgroundTaskModel(),
        modelSettings: agentsRuntimeManager.getBackgroundTaskModelSettings(),
        outputType: EditDecisionSchema,
      });

      const result = await agentsRuntimeManager
        .getRunner()
        .run(agent, `Before edit:\n${before}\n\nAfter edit:\n${after}`, {
          maxTurns: 1,
          signal: abortController.signal,
        });

      const decision = result.finalOutput;
      if (!decision) {
        throw new Error('Edit classifier returned no decision');
      }

      return {
        meaningful: decision.meaningful,
        shouldRegenerate: decision.meaningful && decision.should_regenerate,
        reason: decision.reason || 'classified_by_model',
      };
    } catch (error) {
      aiLogger.warn(
        {
          error: (error as Error).message,
          stack: (error as Error).stack,
          name: (error as Error).name,
          beforePreview: before.slice(0, 120),
          afterPreview: after.slice(0, 120),
        },
        'Edit classifier failed; avoiding automatic regeneration',
      );
      return {
        meaningful: true,
        shouldRegenerate: false,
        reason: 'classification_failed',
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const editClassifier = new EditClassifier();
