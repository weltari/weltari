// The cold-boot onboarding STRUCTURE SKELETON (M7 part 2, Rev 4 §9 Job 0 —
// owner ruling 2026-07-11): the real page is being designed in Figma (the
// GM's character art standing beside interactive chat bubbles) and will be
// built in a later session — docs/onboarding-ui.md is the self-contained
// build instruction for whoever does it. Until then this skeleton keeps the
// blank world usable: it names the moment and hands the user to the GM
// conversation, where the whole interview already works end-to-end.
//
// The slots below (data-slot attributes) are the Figma mount points — keep
// their names when replacing the markup.
import { navigate } from '../router.js';
import { t } from '../i18n.js';

export function OnboardingSplash(): React.JSX.Element {
  return (
    <div className="wl-onboarding" data-slot="onboarding-stage">
      {/* Figma slot: the GM's standing character art. */}
      <div className="wl-onboarding-art" data-slot="gm-art" aria-hidden="true">
        GM
      </div>
      {/* Figma slot: the interactive interview bubbles. The skeleton shows a
          single greeting line; the designed page replaces this with the live
          GM conversation (see docs/onboarding-ui.md §3). */}
      <div className="wl-onboarding-bubble" data-slot="gm-bubble">
        {t('onboarding.greeting')}
      </div>
      <button
        type="button"
        className="wl-button wl-button-accent"
        data-slot="begin"
        onClick={() => {
          navigate('/chats');
        }}
      >
        {t('onboarding.begin')}
      </button>
    </div>
  );
}
