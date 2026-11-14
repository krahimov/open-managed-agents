/**
 * Text links: one look, and a hit area larger than the text.
 *
 * A link set in 13px text is a 16px-tall target, which is small for a
 * pointer and smaller for a finger. Padding would move the text; instead
 * a pseudo-element reaches past the glyphs, so the target grows and the
 * layout does not change by a pixel.
 *
 *   <Link to="/skills" className={inlineLink}>Add one on the Skills page</Link>
 *   <a href={url} target="_blank" rel="noreferrer" className={standaloneLink}>Open thread</a>
 *
 * `inlineLink`      a link inside a sentence, or a short one sitting in a
 *                   row of text ("View session"). 4px beyond the text on
 *                   every side: a 24px target, and still clear of the line
 *                   above and below, so stacked lines never steal clicks.
 * `standaloneLink`  a link on a line of its own with room around it (a
 *                   panel row, a card footer). 8px above and below: 32px.
 * `quietLink`       a small text action that is not a destination ("Show
 *                   more", "Try again", "Use the agent's default"): the
 *                   text colour with a grey underline, the same 24px target.
 * `linkHitArea`     only the hit area, for a link that keeps its own look.
 *
 * Prose that can wrap over several lines (Markdown, a dialog's subtitle)
 * grows its links with `py-1` instead: padding on an inline box widens
 * the target without moving a line, and follows the link across a break.
 */
export const linkHitArea = "relative after:absolute after:-inset-1";

const LOOK =
  "rounded-sm font-medium text-plum underline decoration-plum/40 underline-offset-3 transition-quick hover:decoration-plum";

export const inlineLink = `${LOOK} ${linkHitArea}`;

export const quietLink = `rounded-sm font-medium text-fg-muted underline decoration-border-strong underline-offset-3 transition-quick hover:text-fg hover:decoration-fg-faint ${linkHitArea}`;

export const standaloneLink = `${LOOK} relative inline-flex items-center gap-1 after:absolute after:-inset-x-1.5 after:-inset-y-2`;
