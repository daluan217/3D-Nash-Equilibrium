/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { AlertTriangle, Check } from 'lucide-react';

/**
 * RED-APP-21/002: the ONE element every transient success/failure message
 * renders through, so the live role cannot be forgotten at a call site.
 *
 * The auth modal's error and the Danger Zone's delete error were plain divs —
 * byte-identical markup to three siblings, none of them announced. A screen
 * reader user whose focus was still on the submit button got silence where a
 * sighted user saw "Invalid email/username or password."
 *
 * `role="alert"` for failures (assertive: the user is waiting on an action that
 * just failed), `role="status"` for successes, matching the convention already
 * set by localGamesError, AdminDashboard and the numeric-input hints. The
 * visible text and Tailwind classes are exactly what each call site rendered
 * before; only the role and the shared element are new.
 */
export type FeedbackTone = 'error' | 'success';

const TONE_CLASS: Record<FeedbackTone, string> = {
  error: 'bg-rose-50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-900/40 text-rose-700 dark:text-rose-300',
  success: 'bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-900/40 text-emerald-700 dark:text-emerald-300',
};

export function FeedbackBox({
  tone,
  children,
  className = '',
  testId,
}: {
  tone: FeedbackTone;
  children: React.ReactNode;
  className?: string;
  testId?: string;
}) {
  const Icon = tone === 'error' ? AlertTriangle : Check;
  return (
    <div
      // The invariant this component exists to hold: an error interrupts, a
      // success is polite. Neither is optional, and neither is a prop.
      role={tone === 'error' ? 'alert' : 'status'}
      data-testid={testId}
      className={`${TONE_CLASS[tone]} text-xs rounded-xl p-3 flex ${tone === 'success' ? 'gap-3' : 'gap-2'} font-medium ${className}`}
    >
      <Icon className={`w-4 h-4 shrink-0 ${tone === 'error' ? 'text-rose-500' : 'text-emerald-500'}`} />
      <span>{children}</span>
    </div>
  );
}
