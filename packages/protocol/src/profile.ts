import { z } from 'zod';

// GET /v1/profile (+ /v1/profile/export) wire shapes (0.17.0, M7 part 2,
// Rev 4 §9 Job 2 guardrails): the user's OWN view of the GM's profiling
// store — fully viewable, exportable, deletable (GDPR). The entries travel
// only over this authenticated-local surface; they never ride the event
// stream (the log carries counts alone).

export const ProfileEntrySchema = z.strictObject({
  id: z.int().positive(),
  kind: z.enum(['hypothesis', 'engagement']),
  /** The GM-authored structured text (B6-gated at write). */
  body: z.string(),
  /** The ended scene or chat range the analysis covered. */
  context_id: z.string(),
  /** Wall-clock ISO of the write. */
  created_at: z.string(),
});
export type ProfileEntry = z.infer<typeof ProfileEntrySchema>;

export const UserProfileViewSchema = z.strictObject({
  actor_id: z.string().min(1),
  /** The world flag's current fold — the Config surface renders the toggle
   * and the entries from one fetch. */
  profiling_enabled: z.boolean(),
  entries: z.array(ProfileEntrySchema),
});
export type UserProfileView = z.infer<typeof UserProfileViewSchema>;
