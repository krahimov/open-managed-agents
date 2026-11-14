import { useId, type ReactNode } from "react";
import { PlusIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import { Field } from "../Field";
import { Tip } from "../Tip";
import { isTemplateRubric, type TaskDraft, type TaskFieldErrors } from "./task-draft";

/**
 * The task form: one eval task written field by field (name, the messages
 * the agent is sent, the rubric the judge grades against, trials, a pass
 * mark, a time limit). "Save as eval" and "New eval run" both write tasks
 * with it; each keeps "Edit as JSON" for what the form does not cover.
 *
 *   <TaskBasics task={t} onChange={patch} errors={e} />     name + messages
 *   <TaskGrading task={t} onChange={patch} errors={e} />    rubric + numbers
 *
 * `onChange` gets the fields that changed; the error on a field is cleared
 * by the caller when that field changes (see `clearFor`).
 */
interface TaskPartProps {
  task: TaskDraft;
  onChange: (patch: Partial<TaskDraft>) => void;
  errors: TaskFieldErrors;
  /** Ids start with this, so two tasks on one form never share one. */
  idPrefix?: string;
}

/** The errors that a change to these fields settles. */
export function clearFor(errors: TaskFieldErrors, patch: Partial<TaskDraft>): TaskFieldErrors {
  const map: Array<[keyof TaskDraft, keyof TaskFieldErrors]> = [
    ["id", "taskId"],
    ["messages", "messages"],
    ["rubric", "rubric"],
    ["trials", "trials"],
    ["passThreshold", "threshold"],
    ["timeoutSec", "timeout"],
  ];
  let next = errors;
  for (const [field, key] of map) {
    if (field in patch && next[key]) next = { ...next, [key]: undefined };
  }
  return next;
}

export function TaskBasics({ task, onChange, errors, idPrefix }: TaskPartProps) {
  const auto = useId();
  const prefix = idPrefix ?? auto;
  const messagesLabel = `${prefix}-messages-label`;
  const messagesError = `${prefix}-messages-error`;
  const { messages } = task;
  return (
    <div className="space-y-5">
      <Field label="Name" hint="Lowercase with dashes. It names the task in results." error={errors.taskId}>
        <Input
          id={`${prefix}-task-id`}
          value={task.id}
          onChange={(e) => onChange({ id: e.target.value })}
          placeholder="refund-after-thirty-days"
          spellCheck={false}
          autoComplete="off"
          className="font-mono"
        />
      </Field>
      <div role="group" aria-labelledby={messagesLabel}>
        {/* A click on the label goes to the first message, as a label's would. */}
        <label id={messagesLabel} htmlFor={`${prefix}-message-0`} className="mb-1.5 block text-small leading-5 font-medium text-fg">
          {messages.length > 1 ? "Messages, sent in order" : "Message to the agent"}
        </label>
        <div className="space-y-2">
          {messages.map((m, i) => (
            <div key={i} className="flex items-start gap-2">
              <Textarea
                id={`${prefix}-message-${i}`}
                value={m}
                onChange={(e) => onChange({ messages: messages.map((p, j) => (j === i ? e.target.value : p)) })}
                placeholder={i === 0 ? "What the user asks for" : "A follow-up message"}
                aria-label={messages.length > 1 ? `Message ${i + 1}` : undefined}
                aria-invalid={!!errors.messages && !m.trim()}
                aria-describedby={errors.messages ? messagesError : undefined}
                className="max-h-48 min-h-16"
              />
              {messages.length > 1 && (
                <Tip label="Remove this message">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="mt-1"
                    aria-label={`Remove message ${i + 1}`}
                    onClick={() => onChange({ messages: messages.filter((_, j) => j !== i) })}
                  >
                    <XIcon />
                  </Button>
                </Tip>
              )}
            </div>
          ))}
        </div>
        {errors.messages && (
          <p id={messagesError} role="alert" className="mt-1.5 text-xs text-danger">
            {errors.messages}
          </p>
        )}
        <Button variant="ghost" size="sm" className="mt-1.5 -ml-2" onClick={() => onChange({ messages: [...messages, ""] })}>
          <PlusIcon data-icon="inline-start" />
          Add message
        </Button>
      </div>
    </div>
  );
}

export function TaskGrading({
  task,
  onChange,
  errors,
  idPrefix,
  notice,
}: TaskPartProps & {
  /** Above the rubric: what the caller has to say about it (Save as eval's "This rubric is a template"). */
  notice?: ReactNode;
}) {
  const auto = useId();
  const prefix = idPrefix ?? auto;
  return (
    <div className="space-y-5">
      {notice}
      <Field
        label="Rubric"
        hint={
          !notice && isTemplateRubric(task.rubric)
            ? "Still the template: replace each <placeholder> with what a good answer must contain."
            : "What the judge checks each attempt against, one criterion per line."
        }
        error={errors.rubric}
      >
        <Textarea
          id={`${prefix}-rubric`}
          value={task.rubric}
          onChange={(e) => onChange({ rubric: e.target.value })}
          spellCheck={false}
          className="max-h-72 min-h-44 font-mono text-xs leading-relaxed md:text-xs"
        />
      </Field>
      <div className="grid gap-x-4 gap-y-5 sm:grid-cols-3">
        <Field label="Trials" hint="Times to run it." error={errors.trials}>
          <Input
            id={`${prefix}-trials`}
            type="number"
            min={1}
            step={1}
            value={task.trials}
            onChange={(e) => onChange({ trials: e.target.value })}
          />
        </Field>
        <Field label="Pass mark" hint="Score needed, 0 to 1." error={errors.threshold}>
          <Input
            id={`${prefix}-threshold`}
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={task.passThreshold}
            onChange={(e) => onChange({ passThreshold: e.target.value })}
          />
        </Field>
        <Field label="Time limit" hint="Seconds per trial." error={errors.timeout}>
          <Input
            id={`${prefix}-timeout`}
            type="number"
            min={1}
            step={30}
            value={task.timeoutSec}
            onChange={(e) => onChange({ timeoutSec: e.target.value })}
          />
        </Field>
      </div>
    </div>
  );
}
